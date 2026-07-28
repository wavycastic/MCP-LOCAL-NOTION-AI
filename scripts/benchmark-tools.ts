import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

function git(cwd: string, ...args: string[]) {
	execFileSync("git", args, { cwd, stdio: "pipe" })
}

const workspace = mkdtempSync(join(tmpdir(), "local-repo-mcp-bench-"))
const repoRoot = join(workspace, "bench_repo")
mkdirSync(repoRoot, { recursive: true })
git(repoRoot, "init")
git(repoRoot, "checkout", "-b", "agent/bench")
git(repoRoot, "config", "user.email", "bench@example.com")
git(repoRoot, "config", "user.name", "bench")

// Generate test fixture files
for (let i = 1; i <= 10; i++) {
	const relPath = `src/file_${i}.ts`
	mkdirSync(join(repoRoot, "src"), { recursive: true })
	const lines = Array.from({ length: 50 }, (_, idx) => `export const val_${i}_${idx + 1} = ${idx + 1};`)
	writeFileSync(join(repoRoot, relPath), lines.join("\n") + "\n")
}
git(repoRoot, "add", "-A")
git(repoRoot, "commit", "-m", "init bench repo")

process.env.MCP_TOKEN = "bench-token"
process.env.REPOS_CONFIG = join(workspace, "repos.json")
writeFileSync(
	process.env.REPOS_CONFIG,
	JSON.stringify({
		repos: [{ name: "bench", path: repoRoot, write: true }],
	}),
)
process.env.ALLOW_TERMINAL = "true"

// Import tool handlers
const { editFile } = await import("../src/tools/editFile.js")
const { multiEditFile } = await import("../src/tools/multiEditFile.js")
const { applyPatch } = await import("../src/tools/applyPatch.js")
const { readFile } = await import("../src/tools/readFile.js")
const { readManyFiles } = await import("../src/tools/readManyFiles.js")
const { listDir } = await import("../src/tools/listDir.js")
const { globFiles } = await import("../src/tools/globFiles.js")
const { terminal } = await import("../src/tools/terminal.js")

type MetricResult = {
	name: string
	iterations: number
	medianMs: number
	p95Ms: number
	mcpRoundTrips: number
	totalBytes: number
	successRate: number
}

function calcStats(durations: number[]): { median: number; p95: number } {
	const sorted = [...durations].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
	const p95Idx = Math.min(Math.ceil(0.95 * sorted.length) - 1, sorted.length - 1)
	return { median, p95: sorted[p95Idx] }
}

function resetRepo() {
	git(repoRoot, "checkout", "HEAD", "--", ".")
}

async function runBench(
	name: string,
	iterations: number,
	mcpCallsPerIter: number,
	fn: (iter: number) => Promise<number>,
): Promise<MetricResult> {
	const durations: number[] = []
	let totalBytes = 0
	let successes = 0

	for (let i = 0; i < iterations; i++) {
		resetRepo()
		const t0 = performance.now()
		try {
			const bytes = await fn(i)
			const elapsed = performance.now() - t0
			durations.push(elapsed)
			totalBytes += bytes
			successes++
		} catch (e) {
			durations.push(performance.now() - t0)
		}
	}

	const { median, p95 } = calcStats(durations)
	return {
		name,
		iterations,
		medianMs: Math.round(median * 100) / 100,
		p95Ms: Math.round(p95 * 100) / 100,
		mcpRoundTrips: mcpCallsPerIter,
		totalBytes,
		successRate: (successes / iterations) * 100,
	}
}

console.log("Running Benchmark Suite (20 iterations per case)...\n")

const results: MetricResult[] = []

// Case 1: Single edit
results.push(
	await runBench("Case 1: Single edit (edit_file)", 20, 1, async (iter) => {
		const res = await editFile({
			repo: "bench",
			path: "src/file_1.ts",
			old_str: `export const val_1_1 = 1;`,
			new_str: `export const val_1_1 = 999;`,
		})
		return JSON.stringify(res).length
	}),
)

// Case 2A: 10 sequential edit_file calls
results.push(
	await runBench("Case 2A: 10 edits (10 x edit_file)", 20, 10, async () => {
		let bytes = 0
		for (let k = 1; k <= 10; k++) {
			const res = await editFile({
				repo: "bench",
				path: "src/file_1.ts",
				old_str: `export const val_1_${k} = ${k};`,
				new_str: `export const val_1_${k} = ${990 + k};`,
			})
			bytes += JSON.stringify(res).length
		}
		return bytes
	}),
)

// Case 2B: 10 edits in 1 multi_edit_file call
results.push(
	await runBench("Case 2B: 10 edits (1 x multi_edit_file)", 20, 1, async () => {
		const edits = Array.from({ length: 10 }, (_, idx) => ({
			old_str: `export const val_1_${idx + 1} = ${idx + 1};`,
			new_str: `export const val_1_${idx + 1} = ${990 + idx + 1};`,
		}))
		const res = await multiEditFile({
			repo: "bench",
			path: "src/file_1.ts",
			edits,
		})
		return JSON.stringify(res).length
	}),
)

// Case 3A: 10 file edits (10 individual edit_file calls across files)
results.push(
	await runBench("Case 3A: 10 files (10 x edit_file)", 20, 10, async () => {
		let bytes = 0
		for (let k = 1; k <= 10; k++) {
			const res = await editFile({
				repo: "bench",
				path: `src/file_${k}.ts`,
				old_str: `export const val_${k}_1 = 1;`,
				new_str: `export const val_${k}_1 = 999;`,
			})
			bytes += JSON.stringify(res).length
		}
		return bytes
	}),
)

// Case 3B: 10 file patch (1 x apply_patch)
results.push(
	await runBench("Case 3B: 10 files (1 x apply_patch)", 20, 1, async () => {
		const patchLines = ["*** Begin Patch"]
		for (let k = 1; k <= 10; k++) {
			patchLines.push(`*** Update File: src/file_${k}.ts`)
			patchLines.push(`@@ -1,1 +1,1 @@`)
			patchLines.push(`-export const val_${k}_1 = 1;`)
			patchLines.push(`+export const val_${k}_1 = 999;`)
		}
		patchLines.push("*** End Patch")
		const res = await applyPatch({
			repo: "bench",
			patch_text: patchLines.join("\n"),
		})
		return JSON.stringify(res).length
	}),
)

// Case 4A: 10 file read (10 x read_file)
results.push(
	await runBench("Case 4A: Read 10 files (10 x read_file)", 20, 10, async () => {
		let bytes = 0
		for (let k = 1; k <= 10; k++) {
			const res = await readFile({ repo: "bench", path: `src/file_${k}.ts` })
			bytes += JSON.stringify(res).length
		}
		return bytes
	}),
)

// Case 4B: 10 file read (1 x read_many_files)
results.push(
	await runBench("Case 4B: Read 10 files (1 x read_many_files)", 20, 1, async () => {
		const reqFiles = Array.from({ length: 10 }, (_, idx) => ({ path: `src/file_${idx + 1}.ts` }))
		const res = await readManyFiles({ repo: "bench", files: reqFiles })
		return JSON.stringify(res).length
	}),
)

// Case 5A: Manual recursive list_dir
results.push(
	await runBench("Case 5A: List dir (list_dir)", 20, 1, async () => {
		const res = await listDir({ repo: "bench", path: "src" })
		return JSON.stringify(res).length
	}),
)

// Case 5B: Glob files
results.push(
	await runBench("Case 5B: Glob files (glob_files)", 20, 1, async () => {
		const res = await globFiles({ repo: "bench", patterns: ["src/**/*.ts"] })
		return JSON.stringify(res).length
	}),
)

// Case 6A: Terminal foreground
results.push(
	await runBench("Case 6A: Terminal foreground", 20, 1, async () => {
		const res = await terminal({ repo: "bench", command: "echo hello" })
		return JSON.stringify(res).length
	}),
)

// Case 6B: Terminal background
results.push(
	await runBench("Case 6B: Terminal background", 20, 1, async () => {
		const res = await terminal({ repo: "bench", command: "echo hello", background: true })
		return JSON.stringify(res).length
	}),
)

// Clean up bench workspace
try {
	rmSync(workspace, { recursive: true, force: true })
} catch {}

console.log("| Benchmark Case | Median (ms) | P95 (ms) | Round Trips | Total Out Bytes | Success Rate |")
console.log("| :--- | :---: | :---: | :---: | :---: | :---: |")
for (const r of results) {
	console.log(
		`| ${r.name} | ${r.medianMs}ms | ${r.p95Ms}ms | ${r.mcpRoundTrips} | ${r.totalBytes} B | ${r.successRate}% |`,
	)
}

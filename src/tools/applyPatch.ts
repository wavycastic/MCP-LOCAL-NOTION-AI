import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { assertWritableBranch } from "../git.js"
import { run } from "../exec.js"
import { buildPlan } from "../patch/apply.js"
import { parsePatch } from "../patch/parser.js"
import type { FileSnapshot, PlannedChange } from "../patch/types.js"
import { mapLimit } from "../files/concurrency.js"
import { readTextSnapshot, readTextSnapshotAsync } from "../files/text.js"
import { resolveRepo } from "../repos.js"
import { isDeniedRelPath, safeResolve, safeResolveNew } from "../security/paths.js"
import { noteTouched } from "../touched.js"

export const applyPatchSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	patch_text: z
		.string()
		.describe("Noi dung patch bat dau bang '*** Begin Patch' va ket thuc bang '*** End Patch'"),
	dry_run: z
		.boolean()
		.optional()
		.describe("Mac dinh false. Neu true, chi validate va tinh toán summary/diff, khong ghi len o dia"),
	response_detail: z
		.enum(["summary", "diff", "full"])
		.optional()
		.describe("Muc chi tiet response. Mac dinh: diff cho dry_run, summary khi ghi that"),
	expected_head_sha: z
		.string()
		.optional()
		.describe("Tuoy chon: SHA commit HEAD hien tai cua Git repo. Neu khong khop, tu choi toàn bo patch"),
	expected_files: z
		.array(
			z.object({
				path: z.string().describe("Duong dan tuong doi so voi repo root"),
				sha256: z.string().describe("Hash SHA-256 ky vong cua file"),
			}),
		)
		.optional()
		.describe("Tuong hop chong stale: hash sha256 ky vong cua cac file lien quan truoc khi sua"),
}

function generateDiff(changes: PlannedChange[]): string {
	const lines: string[] = []
	for (const change of changes) {
		if (change.type === "add") {
			lines.push(`--- /dev/null`)
			lines.push(`+++ b/${change.path}`)
			lines.push(`@@ -0,0 +1,${change.newContent.split("\n").length} @@`)
			for (const line of change.newContent.split("\n")) {
				lines.push(`+${line}`)
			}
		} else if (change.type === "delete") {
			lines.push(`--- a/${change.path}`)
			lines.push(`+++ /dev/null`)
			lines.push(`@@ -1,${change.oldContent.split("\n").length} +0,0 @@`)
			for (const line of change.oldContent.split("\n")) {
				lines.push(`-${line}`)
			}
		} else if (change.type === "update") {
			lines.push(`--- a/${change.path}`)
			lines.push(`+++ b/${change.path}`)
			lines.push(change.hunkDiff)
		} else if (change.type === "move") {
			lines.push(`--- a/${change.from}`)
			lines.push(`+++ b/${change.to}`)
			lines.push(change.hunkDiff)
		}
	}
	return lines.join("\n")
}

export async function applyPatch(a: {
	repo?: string
	patch_text: string
	dry_run?: boolean
	response_detail?: "summary" | "diff" | "full"
	expected_head_sha?: string
	expected_files?: Array<{ path: string; sha256: string }>
	__test_fail_commit?: boolean
	__test_fail_after_step?: number
}) {
	// Phase A: Parse
	const parsed = parsePatch(a.patch_text)

	// Phase B: Security & Repository Validation
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)

	// Git HEAD check if expected_head_sha provided
	if (a.expected_head_sha) {
		try {
			const rev = await run(["git", "rev-parse", "HEAD"], { cwd: repo.root })
			const currentHead = rev.stdout.trim()
			if (currentHead !== a.expected_head_sha && !currentHead.startsWith(a.expected_head_sha)) {
				throw new Error(
					`expected_head_sha mismatch for repo '${repo.name}'. Expected: ${a.expected_head_sha}, Actual: ${currentHead}`,
				)
			}
		} catch (e: any) {
			if (e.message?.includes("expected_head_sha mismatch")) throw e
			throw new Error(`Khong the kiem tra expected_head_sha: ${e.message ?? e}`)
		}
	}

	// Detect target path conflicts using resolved canonical absolute paths
	const getCanonical = (p: string, isNew: boolean) => {
		const abs = isNew ? safeResolveNew(repo.root, p) : safeResolve(repo.root, p)
		return process.platform === "win32" ? abs.toLowerCase() : abs
	}

	const targets = new Set<string>()
	const sources = new Set<string>()

	for (const op of parsed.operations) {
		if (op.kind === "add") {
			const np = getCanonical(op.path, true)
			if (targets.has(np)) throw new Error(`apply_patch conflict: Path target bi trung: '${op.path}'`)
			targets.add(np)
		} else if (op.kind === "delete") {
			const np = getCanonical(op.path, false)
			if (sources.has(np)) throw new Error(`apply_patch conflict: File '${op.path}' bi thao tac nhieu lan`)
			sources.add(np)
		} else if (op.kind === "update") {
			const np = getCanonical(op.path, false)
			if (sources.has(np)) throw new Error(`apply_patch conflict: File '${op.path}' bi thao tac nhieu lan`)
			sources.add(np)
			if (op.moveTo) {
				const nmp = getCanonical(op.moveTo, true)
				if (targets.has(nmp)) throw new Error(`apply_patch conflict: Path move target bi trung: '${op.moveTo}'`)
				targets.add(nmp)
			} else {
				targets.add(np)
			}
		}
	}

	// Phase C: collect independent snapshots with bounded concurrency.
	const snapshots = new Map<string, FileSnapshot>()
	const collectedSnapshots = await mapLimit(parsed.operations, 8, async (op) => {
		if (op.kind === "add") {
			if (isDeniedRelPath(op.path)) throw new Error(`Path nam trong deny-list: '${op.path}'`)
			const abs = safeResolveNew(repo.root, op.path)
			if (existsSync(abs)) {
				throw new Error(`apply_patch verification failed: Add File target da ton tai: '${op.path}'`)
			}
			return [op.path, { path: op.path, existed: false } satisfies FileSnapshot] as const
		} else if (op.kind === "delete") {
			if (isDeniedRelPath(op.path)) throw new Error(`Path nam trong deny-list: '${op.path}'`)
			const abs = safeResolve(repo.root, op.path)
			const st = statSync(abs)
			if (st.isDirectory()) {
				throw new Error(`apply_patch verification failed: Delete File khong ho tro thu muc: '${op.path}'`)
			}
			try {
				const snap = await readTextSnapshotAsync(abs)
				return [op.path, {
					path: op.path,
					existed: true,
					content: snap.text,
					sha256: snap.sha256,
					mode: snap.mode,
					buffer: snap.buffer,
				} satisfies FileSnapshot] as const
			} catch (err: any) {
				throw new Error(`apply_patch does not support non-UTF-8 or binary files: ${op.path}`)
			}
		} else if (op.kind === "update") {
			if (isDeniedRelPath(op.path)) throw new Error(`Path nam trong deny-list: '${op.path}'`)
			const srcAbs = safeResolve(repo.root, op.path)
			const st = statSync(srcAbs)
			if (st.isDirectory()) {
				throw new Error(`apply_patch verification failed: Update File khong ho tro thu muc: '${op.path}'`)
			}

			if (op.moveTo) {
				if (isDeniedRelPath(op.moveTo)) throw new Error(`Path nam trong deny-list: '${op.moveTo}'`)
				const destAbs = safeResolveNew(repo.root, op.moveTo)
				if (existsSync(destAbs)) {
					throw new Error(`apply_patch verification failed: Move target da ton tai: '${op.moveTo}'`)
				}
			}

			try {
				const snap = await readTextSnapshotAsync(srcAbs)
				return [op.path, {
					path: op.path,
					existed: true,
					content: snap.text,
					sha256: snap.sha256,
					eol: snap.eol,
					bom: snap.bom,
					mode: snap.mode,
					buffer: snap.buffer,
				} satisfies FileSnapshot] as const
			} catch (err: any) {
				throw new Error(`apply_patch does not support non-UTF-8 or binary files: ${op.path}`)
			}
		}
		throw new Error("apply_patch verification failed: unsupported operation")
	})
	for (const [path, snapshot] of collectedSnapshots) snapshots.set(path, snapshot)

	// Validate expected_files hashes if provided (with deny-list check and no hash oracle leak)
	if (a.expected_files) {
		for (const ef of a.expected_files) {
			if (isDeniedRelPath(ef.path)) {
				throw new Error(`Path nam trong deny-list: '${ef.path}'`)
			}
			const abs = safeResolve(repo.root, ef.path)
			try {
				const snap = readTextSnapshot(abs)
				if (snap.sha256 !== ef.sha256) {
					throw new Error(`expected_files sha256 mismatch cho '${ef.path}'`)
				}
			} catch (err: any) {
				if (err.message?.includes("expected_files sha256 mismatch")) throw err
				throw new Error(`apply_patch does not support non-UTF-8 or binary files: ${ef.path}`)
			}
		}
	}

	// Phase D: Build Plan in RAM
	const plan = buildPlan(parsed.operations, snapshots)

	// Phase E: Build only the response detail requested. Avoid generating large
	// diffs for normal writes; dry-run keeps diff output by default.
	const responseDetail = a.response_detail ?? (a.dry_run ? "diff" : "summary")
	const fullDiff = responseDetail === "summary" ? "" : generateDiff(plan.changes)
	const diffTruncated = fullDiff.length > 50_000
	const diffSummary = diffTruncated ? fullDiff.slice(0, 50_000) + "\n... [diff truncated]" : fullDiff

	if (a.dry_run) {
		return {
			repo: repo.name,
			branch,
			dry_run: true,
			files_changed: plan.changes.length,
			additions: plan.totalAdditions,
			deletions: plan.totalDeletions,
			response_detail: responseDetail,
			changes: plan.changes.map((c) => ({
				operation: c.type,
				path: c.type === "move" ? c.to : c.path,
				from: c.type === "move" ? c.from : undefined,
				to: c.type === "move" ? c.to : undefined,
				...(responseDetail === "full" ? {
					bytes_before: c.type === "add" ? 0 : c.bytesBefore,
					bytes_after: c.type === "delete" ? 0 : c.bytesAfter,
					sha256_before: c.type === "add" ? undefined : c.sha256Before,
					sha256_after: c.type === "delete" ? undefined : c.sha256After,
				} : {}),
				replacements: "replacements" in c ? c.replacements : undefined,
			})),
			...(responseDetail === "summary" ? {} : { diff: diffSummary, diff_truncated: diffTruncated }),
		}
	}

	// Phase F: Commit Plan via Atomic Temp-File Write & Rollback Best-Effort
	const writtenTemps: Array<{ tmpPath: string; targetAbs: string }> = []
	const touchedPaths: string[] = []

	try {
		let renamedCount = 0
		let unlinkedCount = 0

		// Step 1: prepare temp files concurrently, but keep rename/unlink commit
		// steps ordered so rollback semantics remain deterministic.
		const preparedTemps = await mapLimit(plan.changes, 8, async (change) => {
			try {
				if (change.type === "delete") {
					return { ok: true as const, touched: [change.path] }
				}
				const targetAbs = change.type === "move"
					? safeResolveNew(repo.root, change.to)
					: change.type === "add"
						? safeResolveNew(repo.root, change.path)
						: safeResolve(repo.root, change.path)
				await mkdir(dirname(targetAbs), { recursive: true })
				const tmpPath = `${targetAbs}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
				const mode = change.type === "update"
					? snapshots.get(change.path)?.mode
					: change.type === "move"
						? snapshots.get(change.from)?.mode
						: undefined
				await writeFile(tmpPath, change.newContent, { flag: "wx", mode })
				return {
					ok: true as const,
					temp: { tmpPath, targetAbs },
					touched: change.type === "move" ? [change.from, change.to] : [change.path],
				}
			} catch (error) {
				return { ok: false as const, error }
			}
		})
		for (const prepared of preparedTemps) {
			if (prepared.ok) {
				if (prepared.temp) writtenTemps.push(prepared.temp)
				touchedPaths.push(...prepared.touched)
			} else {
				throw prepared.error
			}
		}
		if (a.__test_fail_after_step === 1 && writtenTemps.length > 0) {
			throw new Error("Fault injection test error during Step 1 (temp write)")
		}

		// Step 2: Atomic rename temp files into targets
		for (const { tmpPath, targetAbs } of writtenTemps) {
			renameSync(tmpPath, targetAbs)
			renamedCount++
			if (a.__test_fail_after_step === 2 && renamedCount >= 1) {
				throw new Error("Fault injection test error during Step 2 (mid-rename)")
			}
		}

		// Step 3: Perform deletes and move source unlinks
		for (const change of plan.changes) {
			if (change.type === "delete") {
				const abs = safeResolve(repo.root, change.path)
				if (existsSync(abs)) unlinkSync(abs)
				unlinkedCount++
			} else if (change.type === "move") {
				const srcAbs = safeResolve(repo.root, change.from)
				if (existsSync(srcAbs)) unlinkSync(srcAbs)
				unlinkedCount++
			}
			if (a.__test_fail_after_step === 3 && unlinkedCount >= 1) {
				throw new Error("Fault injection test error during Step 3 (mid-unlink)")
			}
		}

		if (a.__test_fail_commit) {
			throw new Error("Fault injection test error during commit phase")
		}
	} catch (commitErr: any) {
		// Rollback best-effort: restore exact raw buffer & permissions
		let rollbackSuccess = true
		try {
			// Remove temporary files
			for (const { tmpPath } of writtenTemps) {
				if (existsSync(tmpPath)) {
					try {
						unlinkSync(tmpPath)
					} catch {}
				}
			}
			// Restore original raw content & mode from snapshots
			for (const change of plan.changes) {
				if (change.type === "add") {
					const abs = safeResolveNew(repo.root, change.path)
					if (existsSync(abs)) unlinkSync(abs)
				} else if (change.type === "update") {
					const abs = safeResolveNew(repo.root, change.path)
					const snap = snapshots.get(change.path)
					if (snap?.buffer) {
						writeFileSync(abs, snap.buffer, { mode: snap.mode })
					} else {
						writeFileSync(abs, change.oldContent, "utf8")
					}
				} else if (change.type === "move") {
					const srcAbs = safeResolveNew(repo.root, change.from)
					mkdirSync(dirname(srcAbs), { recursive: true })
					const snap = snapshots.get(change.from)
					if (snap?.buffer) {
						writeFileSync(srcAbs, snap.buffer, { mode: snap.mode })
					} else {
						writeFileSync(srcAbs, change.oldContent, "utf8")
					}
					const destAbs = safeResolveNew(repo.root, change.to)
					if (existsSync(destAbs)) unlinkSync(destAbs)
				} else if (change.type === "delete") {
					const abs = safeResolveNew(repo.root, change.path)
					mkdirSync(dirname(abs), { recursive: true })
					const snap = snapshots.get(change.path)
					if (snap?.buffer) {
						writeFileSync(abs, snap.buffer, { mode: snap.mode })
					} else {
						writeFileSync(abs, change.oldContent, "utf8")
					}
				}
			}
		} catch (rbErr) {
			rollbackSuccess = false
		}

		throw new Error(
			`apply_patch commit phase failed (${commitErr.message ?? commitErr}). ` +
				`Rollback status: ${rollbackSuccess ? "THANH CONG (files da duoc khoi phuc)" : "KHONG HOAN CHINH (can kiem tra lai working tree)"}`,
		)
	}

	// Notify touched paths
	for (const p of touchedPaths) {
		noteTouched(repo.root, p)
	}

	return {
		repo: repo.name,
		branch,
		dry_run: false,
		files_changed: plan.changes.length,
		additions: plan.totalAdditions,
		deletions: plan.totalDeletions,
		response_detail: responseDetail,
		changes: plan.changes.map((c) => ({
			operation: c.type,
			path: c.type === "move" ? c.to : c.path,
			from: c.type === "move" ? c.from : undefined,
			to: c.type === "move" ? c.to : undefined,
			...(responseDetail === "full" ? {
				bytes_before: c.type === "add" ? 0 : c.bytesBefore,
				bytes_after: c.type === "delete" ? 0 : c.bytesAfter,
				sha256_before: c.type === "add" ? undefined : c.sha256Before,
				sha256_after: c.type === "delete" ? undefined : c.sha256After,
			} : {}),
			replacements: "replacements" in c ? c.replacements : undefined,
		})),
		...(responseDetail === "summary" ? {} : { diff: diffSummary, diff_truncated: diffTruncated }),
	}
}

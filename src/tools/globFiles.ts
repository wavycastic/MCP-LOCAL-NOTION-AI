import { relative, sep } from "node:path"
import { z } from "zod"
import { run } from "../exec.js"
import { resolveRepo } from "../repos.js"
import { isDeniedRelPath, safeResolveDir } from "../security/paths.js"

export const globFilesSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	patterns: z
		.array(z.string())
		.min(1)
		.describe("Danh sach cac glob pattern (vd: ['**/*.ts', 'src/**/*.json'])"),
	path: z.string().optional().describe("Thu muc con de tim trong repo (mac dinh: repo root)"),
	include_ignored: z.boolean().optional().describe("Neu true, bao gom ca cac file bi ignore (nhung van chan deny-list)"),
	max_results: z.number().int().min(1).optional().describe("So luong ket qua toi da (mac dinh 1000)"),
}

const DEFAULT_IGNORE_GLOBS = [
	"!.git",
	"!node_modules",
	"!bin",
	"!obj",
	"!dist",
	"!target",
	"!.venv",
]

function globToRegex(glob: string): RegExp {
	let p = glob.replace(/\\/g, "/")
	if (!p.startsWith("/") && !p.startsWith("**")) {
		p = "**/" + p
	}
	let regexStr = "^"
	let i = 0
	while (i < p.length) {
		const char = p[i]
		if (char === "*") {
			if (p[i + 1] === "*") {
				if (p[i + 2] === "/") {
					regexStr += "(?:.*\\/|)"
					i += 3
				} else {
					regexStr += ".*"
					i += 2
				}
			} else {
				regexStr += "[^/]*"
				i++
			}
		} else if (char === "?") {
			regexStr += "[^/]"
			i++
		} else if ("./+^$()[]{}|\\".includes(char)) {
			regexStr += "\\" + char
			i++
		} else {
			regexStr += char
			i++
		}
	}
	regexStr += "$"
	return new RegExp(regexStr)
}

function matchesAnyPattern(relPath: string, patterns: string[]): boolean {
	const norm = relPath.replace(/\\/g, "/")
	return patterns.some((pat) => globToRegex(pat).test(norm))
}

function sortPaths(paths: string[]): string[] {
	return paths.sort((a, b) => {
		const depthA = a.split("/").length
		const depthB = b.split("/").length
		if (depthA !== depthB) return depthA - depthB
		if (a.length !== b.length) return a.length - b.length
		return a.localeCompare(b)
	})
}

export async function globFiles(a: {
	repo?: string
	patterns: string[]
	path?: string
	include_ignored?: boolean
	max_results?: number
	__force_fallback?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const cwd = safeResolveDir(repo.root, a.path)
	const maxResults = a.max_results ?? 1000

	let engine: "ripgrep" | "git-ls-files" = "ripgrep"
	let rawPaths: string[] = []

	if (!a.__force_fallback) {
		const rgArgv = ["rg", "--files", "--color=never"]
		if (!a.include_ignored) {
			rgArgv.push("--hidden")
			for (const ig of DEFAULT_IGNORE_GLOBS) {
				rgArgv.push("-g", ig)
			}
		} else {
			rgArgv.push("--no-ignore")
		}

		for (const p of a.patterns) {
			rgArgv.push("-g", p)
		}

		try {
			const res = await run(rgArgv, { cwd, timeoutMs: 15_000 })
			if (res.code === 0) {
				rawPaths = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
			} else if (res.code === 1) {
				// Exit code 1 means 0 matches found — return empty paths list
				rawPaths = []
			} else {
				throw new Error(`rg exit code ${res.code}`)
			}
		} catch {
			engine = "git-ls-files"
		}
	} else {
		engine = "git-ls-files"
	}

	if (engine === "git-ls-files") {
		try {
			const lsRes = await run(["git", "ls-files"], { cwd, timeoutMs: 15_000 })
			if (lsRes.code === 0) {
				const allTracked = lsRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
				// Filter tracked paths by patterns using glob matching
				rawPaths = allTracked.filter((p) => matchesAnyPattern(p, a.patterns))
			}
		} catch {
			rawPaths = []
		}
	}

	// Calculate paths relative to repo root
	const relToRepo = cwd === repo.root
	const normalized: string[] = []

	for (const p of rawPaths) {
		const normPath = relToRepo ? p.split(sep).join("/") : relative(repo.root, `${cwd}/${p}`).split(sep).join("/")
		if (isDeniedRelPath(normPath)) continue
		normalized.push(normPath)
	}

	const sorted = sortPaths(normalized)
	const truncated = sorted.length > maxResults
	const finalPaths = sorted.slice(0, maxResults)

	return {
		repo: repo.name,
		engine,
		paths: finalPaths,
		total_returned: finalPaths.length,
		truncated,
	}
}

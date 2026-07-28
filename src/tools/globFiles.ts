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
	use_cache: z.boolean().optional().describe("Mac dinh true: cache ket qua 250ms; write tools se invalidate ngay"),
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

const GLOB_CACHE_TTL_MS = 250
const regexCache = new Map<string, RegExp>()
type GlobResult = { repo: string; engine: "ripgrep" | "git-ls-files"; paths: string[]; total_returned: number; truncated: boolean; cache_hit: boolean }
const resultCache = new Map<string, { expiresAt: number; result: GlobResult }>()

export function invalidateGlobCache(repoRoot?: string): void {
	if (!repoRoot) {
		resultCache.clear()
		return
	}
	for (const key of resultCache.keys()) {
		if (key.startsWith(`${repoRoot}\u0000`)) resultCache.delete(key)
	}
}

function globToRegex(glob: string): RegExp {
	const cached = regexCache.get(glob)
	if (cached) return cached
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
	const compiled = new RegExp(regexStr)
	regexCache.set(glob, compiled)
	return compiled
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
	use_cache?: boolean
	__force_fallback?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const cwd = safeResolveDir(repo.root, a.path)
	const maxResults = a.max_results ?? 1000
	const cacheKey = [repo.root, cwd, a.patterns.join("\u0001"), String(!!a.include_ignored), String(maxResults), String(!!a.__force_fallback)].join("\u0000")
	if (a.use_cache !== false) {
		const cached = resultCache.get(cacheKey)
		if (cached && cached.expiresAt > Date.now()) {
			return { ...cached.result, paths: [...cached.result.paths], cache_hit: true }
		}
	}

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

	const result: GlobResult = {
		repo: repo.name,
		engine,
		paths: finalPaths,
		total_returned: finalPaths.length,
		truncated,
		cache_hit: false,
	}
	if (a.use_cache !== false) {
		resultCache.set(cacheKey, { expiresAt: Date.now() + GLOB_CACHE_TTL_MS, result })
	}
	return result
}

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, join } from "node:path"
import {
	AUTO_DISCOVERED_WRITE,
	ALLOW_FULL_ACCESS,
	DEFAULT_BRANCH_PREFIX,
	DEFAULT_REINDEX_CMD,
	REPOS_CONFIG,
	WORKSPACE_ROOT,
} from "./config.js"
import { detectToolchain } from "./toolchain.js"

export type Repo = {
	name: string
	root: string
	/** Cho phep edit/create/move/remove/commit/push khong. */
	write: boolean
	branchPrefix: string
	build?: string[]
	test?: string[]
	lint?: string[]
	typecheck?: string[]
	reindex: string[]
	toolchain: string
	source: "config" | "discovered" | "system"
}

type RepoEntry = {
	name?: string
	path: string
	write?: boolean
	branchPrefix?: string
	build?: string[]
	test?: string[]
	lint?: string[]
	typecheck?: string[]
	reindex?: string[]
}

type ReposFile = {
	defaults?: { branchPrefix?: string; reindex?: string[] }
	repos?: RepoEntry[]
}

export class RepoError extends Error {}

let cache: { at: number; repos: Repo[] } | null = null
const CACHE_MS = 10_000

function readConfig(): ReposFile {
	if (!existsSync(REPOS_CONFIG)) return {}
	try {
		return JSON.parse(readFileSync(REPOS_CONFIG, "utf8")) as ReposFile
	} catch (e) {
		throw new RepoError(`${REPOS_CONFIG} khong parse duoc: ${String(e)}`)
	}
}

function isArgv(v: unknown): v is string[] {
	return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")
}

function build(entry: RepoEntry, dflt: ReposFile["defaults"], source: Repo["source"]): Repo {
	const root = realpathSync(entry.path)
	// basename, khong phai split("/"): tren Windows realpath tra ve "E:\Projects\CV-AUT"
	// nen split("/") khong cat duoc gi va ten repo thanh ca duong dan.
	const name = entry.name ?? basename(root) ?? root
	const tc = detectToolchain(root)

	for (const [k, v] of [
		["build", entry.build],
		["test", entry.test],
		["lint", entry.lint],
		["typecheck", entry.typecheck],
		["reindex", entry.reindex],
	] as const) {
		if (v !== undefined && !isArgv(v))
			throw new RepoError(`repo "${name}": ${k} phai la mang argv, vd ["dotnet","build"]`)
	}

	return {
		name,
		root,
		write: entry.write ?? (source === "config" ? false : AUTO_DISCOVERED_WRITE),
		branchPrefix: entry.branchPrefix ?? dflt?.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
		build: entry.build ?? tc.build,
		test: entry.test ?? tc.test,
		lint: entry.lint ?? tc.lint,
		typecheck: entry.typecheck ?? tc.typecheck,
		reindex: entry.reindex ?? dflt?.reindex ?? DEFAULT_REINDEX_CMD,
		toolchain: tc.kind,
		source,
	}
}

/**
 * Ten repo la DINH DANH duy nhat ma agent dung de tro tro toi repo. Neu hai repo
 * khac duong dan ma cung ten thi `resolveRepo` se luon tra ve cai dau tien —
 * agent tuong dang ghi vao repo A trong khi thuc te ghi vao repo B, va khong co
 * dau hieu gi. Chet im lang nhu vay te hon la sap ngay, nen: sap ngay.
 */
function assertUniqueNames(repos: Repo[]): void {
	const byName = new Map<string, string[]>()
	for (const r of repos) {
		const k = r.name.toLowerCase()
		byName.set(k, [...(byName.get(k) ?? []), r.root])
	}
	const dups = [...byName.entries()].filter(([, roots]) => roots.length > 1)
	if (dups.length === 0) return

	const detail = dups
		.map(([name, roots]) => `"${name}": ${roots.join(" | ")}`)
		.join("; ")
	throw new RepoError(
		`co ${dups.length} ten repo bi trung — ${detail}. ` +
			`Dat "name" khac cho chung trong ${REPOS_CONFIG}, hoac bo mot trong hai khoi WORKSPACE_ROOT`,
	)
}

/** Repo khai bao trong repos.json + repo tim thay trong WORKSPACE_ROOT. Config thang. */
export function allRepos(): Repo[] {
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.repos

	const cfg = readConfig()
	const byRoot = new Map<string, Repo>()

	for (const entry of cfg.repos ?? []) {
		if (!entry?.path) throw new RepoError("moi entry trong repos.json can truong \"path\"")
		if (!existsSync(entry.path)) continue // repo chua clone: bo qua thay vi lam sap server
		const r = build(entry, cfg.defaults, "config")
		byRoot.set(r.root, r)
	}

	if (WORKSPACE_ROOT) {
		for (const e of readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
			if (!e.isDirectory() && !e.isSymbolicLink()) continue
			const p = join(WORKSPACE_ROOT, e.name)
			if (!existsSync(join(p, ".git"))) continue
			const root = realpathSync(p)
			if (byRoot.has(root)) continue // repos.json thang
			byRoot.set(root, build({ path: p, name: e.name }, cfg.defaults, "discovered"))
		}
	}

	if (ALLOW_FULL_ACCESS) {
		byRoot.set("__system__", {
			name: "system",
			root: "__FULL_ACCESS__",
			write: true,
			branchPrefix: "*",
			reindex: DEFAULT_REINDEX_CMD,
			toolchain: "system",
			source: "system",
		})
	}

	const repos = [...byRoot.values()].sort((a, b) => a.name.localeCompare(b.name))
	assertUniqueNames(repos) // truoc khi cache: cau hinh sai thi khong duoc "dinh" lai
	cache = { at: Date.now(), repos }
	return repos
}

/** Xoa cache — goi khi vua clone repo moi ma khong muon doi 10s. */
export function invalidateRepoCache() {
	cache = null
}

/**
 * Tim repo theo ten (case-insensitive). Neu bo trong va chi co dung 1 repo
 * thi dung repo do; nhieu repo thi bat buoc phai chi ro.
 */
export function resolveRepo(name?: string): Repo {
	const repos = allRepos()
	if (repos.length === 0)
		throw new RepoError(
			`khong co repo nao. Khai bao trong ${REPOS_CONFIG} hoac dat WORKSPACE_ROOT`,
		)

	const wanted = name?.trim()
	if (!wanted) {
		const system = repos.find((r) => r.source === "system")
		if (system) return system
		if (repos.length === 1) return repos[0]
		throw new RepoError(
			`can chi ro tham so "repo". Dang co: ${repos.map((r) => r.name).join(", ")}`,
		)
	}

	const hit = repos.find((r) => r.name.toLowerCase() === wanted.toLowerCase())
	if (!hit)
		throw new RepoError(
			`khong biet repo "${wanted}". Dang co: ${repos.map((r) => r.name).join(", ")}`,
		)
	return hit
}

/** Chan ghi vao repo chi-doc (mac dinh cua moi repo). */
export function assertWritableRepo(repo: Repo): void {
	if (repo.source === "system") return
	if (!repo.write)
		throw new RepoError(
			`repo "${repo.name}" la chi-doc. Dat "write": true cho no trong ${REPOS_CONFIG} neu muon cho ghi`,
		)
}

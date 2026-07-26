import { realpathSync } from "node:fs"
import { resolve } from "node:path"

function req(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`missing env ${name}`)
	return v
}

function bool(name: string, dflt: boolean): boolean {
	const v = process.env[name]
	if (v === undefined || v === "") return dflt
	return /^(1|true|yes|on)$/i.test(v)
}

function optRealpath(name: string): string | null {
	const v = process.env[name]
	if (!v) return null
	try {
		return realpathSync(v)
	} catch {
		throw new Error(`${name}=${v} khong ton tai`)
	}
}

export const MCP_TOKEN = req("MCP_TOKEN")
export const PORT = Number(process.env.PORT ?? 8765)

/**
 * Thu muc chua nhieu repo (moi subdir co .git la mot repo). Tuy chon.
 * Repo tim thay bang cach nay mac dinh CHI DOC — xem AUTO_DISCOVERED_WRITE.
 */
export const WORKSPACE_ROOT = optRealpath("WORKSPACE_ROOT")

/** File khai bao repo tuong minh (quyen ghi, build/test cmd). */
export const REPOS_CONFIG = resolve(process.env.REPOS_CONFIG ?? "repos.json")

/** Repo tu dong tim thay co duoc ghi khong. Mac dinh khong. */
export const AUTO_DISCOVERED_WRITE = bool("AUTO_DISCOVERED_WRITE", false)

/** Prefix branch cho phep ghi, dung khi repo khong khai bao rieng. */
export const DEFAULT_BRANCH_PREFIX = process.env.DEFAULT_BRANCH_PREFIX ?? "agent/"

export const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS ?? 900_000)
export const MAX_OUTPUT = 200_000
export const MAX_WRITE_BYTES = Number(process.env.MAX_WRITE_BYTES ?? 1_000_000)

/** Kill switch toan cuc cho git_push. Repo van phai tu bat write. */
export const ALLOW_PUSH = bool("ALLOW_PUSH", false)
export const GIT_REMOTE = process.env.GIT_REMOTE ?? "origin"

/** Lenh reindex code graph mac dinh, chay trong tung repo. */
export const DEFAULT_REINDEX_CMD = (
	process.env.DEFAULT_REINDEX_CMD ?? "npx gitnexus analyze"
).split(" ")

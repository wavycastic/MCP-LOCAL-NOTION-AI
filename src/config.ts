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

/**
 * Tach mot dong lenh thanh argv, co ton trong "..." va '...'.
 *
 * Truoc day chi .split(" "): dat
 *   DEFAULT_REINDEX_CMD="C:/Program Files/nodejs/npx.cmd gitnexus analyze"
 * se thanh ["C:/Program", "Files/nodejs/npx.cmd", ...] va bao "khong tim thay
 * lenh" — ma duong dan co khoang trang la chuyen thuong ngay tren Windows.
 */
function argvFromEnv(name: string, dflt: string): string[] {
	const raw = (process.env[name] ?? dflt).trim()
	const out: string[] = []
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g
	let m: RegExpExecArray | null
	while ((m = re.exec(raw)) !== null) {
		out.push(m[1] ?? m[2] ?? m[3] ?? "")
	}
	if (out.length === 0) throw new Error(`${name} rong — can it nhat mot lenh`)
	return out
}

export const MCP_TOKEN = req("MCP_TOKEN")
export const PORT = Number(process.env.PORT ?? 8765)
export const HOST = process.env.HOST ?? "127.0.0.1"

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

/**
 * Tran cho read_file. File to hon nay thi tu choi doc thay vi nap ca vao RAM roi
 * nhoi vao context cua agent (mot file dump 500MB du de ha ca server).
 */
export const MAX_READ_BYTES = Number(process.env.MAX_READ_BYTES ?? 2_000_000)

/**
 * Thoi gian toi da mot tool chiu xep hang cho repo ranh. Het gio thi bao loi ro
 * ("repo dang chay X") — truoc day agent chi thay dung may khong hieu vi sao.
 */
export const LOCK_WAIT_MS = Number(process.env.LOCK_WAIT_MS ?? 120_000)

/**
 * run_build/run_tests kieu dong bo chi giu HTTP request toi day, sau do tu lui ve
 * background va tra job_id. Phai NHO hon nhieu so voi EXEC_TIMEOUT_MS: client MCP
 * va tunnel se ngat truoc khi mot ban build 15 phut kip xong.
 */
export const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS ?? 60_000)

/** Kill switch toan cuc cho git_push. Repo van phai tu bat write. */
export const ALLOW_PUSH = bool("ALLOW_PUSH", false)
export const GIT_REMOTE = process.env.GIT_REMOTE ?? "origin"

/** Lenh reindex code graph mac dinh, chay trong tung repo. */
export const DEFAULT_REINDEX_CMD = argvFromEnv("DEFAULT_REINDEX_CMD", "npx gitnexus analyze")

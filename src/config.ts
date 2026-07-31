import { existsSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))

function findReposConfig(): string {
	if (process.env.REPOS_CONFIG) {
		const envPath = resolve(appDir, process.env.REPOS_CONFIG)
		if (existsSync(envPath)) return envPath
	}
	// appDir xuong duoi cung: trong ban dong goi day la resources/app, chi chua ban
	// repos.json mac dinh di kem app. Cau hinh that cua nguoi dung nam ngoai bundle.
	const candidates = [
		resolve(process.cwd(), "repos.json"),
		...(process.env.LOCAL_REPO_MCP_HOME ? [resolve(process.env.LOCAL_REPO_MCP_HOME, "repos.json")] : []),
		...(process.env.PORTABLE_EXECUTABLE_DIR ? [resolve(process.env.PORTABLE_EXECUTABLE_DIR, "repos.json")] : []),
		resolve(dirname(appDir), "repos.json"),
		resolve(appDir, "repos.json"),
	]
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}
	return resolve(appDir, "repos.json")
}

/** File khai bao repo tuong minh (quyen ghi, build/test cmd). */
export const REPOS_CONFIG = findReposConfig()

/** Repo tu dong tim thay co duoc ghi khong. Mac dinh khong. */
export const AUTO_DISCOVERED_WRITE = bool("AUTO_DISCOVERED_WRITE", false)

/** Kill switch cho FlowLens semantic search & code graph. Mac dinh TRUE. */
export const ALLOW_FLOWLENS = bool("ALLOW_FLOWLENS", true)

/** Kill switch cho GitNexus MCP proxy. Mac dinh TRUE. */
export const ALLOW_GITNEXUS = bool("ALLOW_GITNEXUS", true)

/**
 * Che do toan quyen may cuc bo. Khi bat, them repo ao "system" cho phep dung
 * duong dan tuyet doi (C:\..., E:\...) va chay terminal o bat ky thu muc nao.
 *
 * Mac dinh FALSE (fail-closed). Dat ALLOW_FULL_ACCESS=true de mo.
 */
export const ALLOW_FULL_ACCESS = bool("ALLOW_FULL_ACCESS", false)

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

/**
 * Kill switch cho tool chay terminal lenh tu do. Mac dinh TAT de an toan cho nguoi dung moi.
 */
export const ALLOW_TERMINAL = bool("ALLOW_TERMINAL", false)

export type TerminalMode = "disabled" | "repo" | "full"
const rawTermMode = (process.env.TERMINAL_MODE ?? "").toLowerCase()
export const TERMINAL_MODE: TerminalMode = !ALLOW_TERMINAL || rawTermMode === "disabled"
	? "disabled"
	: rawTermMode === "repo"
		? "repo"
		: "full"

export const TERMINAL_MAX_COMMAND_CHARS = Number(process.env.TERMINAL_MAX_COMMAND_CHARS ?? 20_000)
export const TERMINAL_MAX_OUTPUT_BYTES = Number(process.env.TERMINAL_MAX_OUTPUT_BYTES ?? 200_000)
export const TERMINAL_INHERIT_SECRETS = bool("TERMINAL_INHERIT_SECRETS", false)

/** Interactive PTY session limits. PTY inherits the server process privileges. */
export const PTY_MAX_SESSIONS = Number(process.env.PTY_MAX_SESSIONS ?? 8)
export const PTY_BUFFER_BYTES = Number(process.env.PTY_BUFFER_BYTES ?? 1_000_000)
export const PTY_READ_MAX_BYTES = Number(process.env.PTY_READ_MAX_BYTES ?? 100_000)
export const PTY_MAX_INPUT_CHARS = Number(process.env.PTY_MAX_INPUT_CHARS ?? 100_000)
export const PTY_IDLE_TIMEOUT_MS = Number(process.env.PTY_IDLE_TIMEOUT_MS ?? 30 * 60_000)
export const PTY_MAX_LIFETIME_MS = Number(process.env.PTY_MAX_LIFETIME_MS ?? 4 * 60 * 60_000)

export type ToolProfile = "agent" | "core" | "safe" | "full"
const rawProfile = (process.env.TOOL_PROFILE ?? "full").toLowerCase()
export const TOOL_PROFILE: ToolProfile =
	rawProfile === "agent" ? "agent" : rawProfile === "core" ? "core" : rawProfile === "safe" ? "safe" : "full"

/** Lenh reindex code graph mac dinh, chay trong tung repo. */
export const DEFAULT_REINDEX_CMD = argvFromEnv("DEFAULT_REINDEX_CMD", "npx gitnexus analyze")

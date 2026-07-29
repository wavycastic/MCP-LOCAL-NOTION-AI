import { z } from "zod"
import {
	ALLOW_TERMINAL,
	PTY_MAX_INPUT_CHARS,
	PTY_READ_MAX_BYTES,
	TERMINAL_INHERIT_SECRETS,
	TERMINAL_MAX_COMMAND_CHARS,
	TERMINAL_MODE,
} from "../config.js"
import { buildTerminalEnv } from "../exec.js"
import { withLock } from "../lock.js"
import {
	assertPtySessionRepo,
	closePtySession,
	listPtySessions,
	readPtySession,
	resizePtySession,
	startPtySession,
	waitForPtySession,
	writePtySession,
} from "../ptySessions.js"
import { resolveRepo } from "../repos.js"
import { safeResolveDir } from "../security/paths.js"
import type { ShellKind } from "../terminalShell.js"

const shellSchema = z.enum(["cmd", "powershell", "pwsh", "bash", "sh"])

function assertPtyEnabled(): void {
	if (!ALLOW_TERMINAL || TERMINAL_MODE === "disabled") {
		throw new Error("PTY terminal dang tat. Dat ALLOW_TERMINAL=true va TERMINAL_MODE=repo|full")
	}
}

export const terminalStartSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	command: z.string().min(1).max(TERMINAL_MAX_COMMAND_CHARS).optional().describe("Lenh ban dau; bo trong de mo interactive shell"),
	dir: z.string().optional().describe("Thu muc con tuong doi repo root"),
	shell: shellSchema.optional().describe("Shell PTY: cmd, powershell, pwsh, bash, sh"),
	env: z.record(z.string()).optional().describe("Bien moi truong ghi de; secret duoc sanitize theo terminal policy"),
	cols: z.number().int().min(20).max(500).optional().describe("So cot, mac dinh 120"),
	rows: z.number().int().min(5).max(200).optional().describe("So dong, mac dinh 30"),
}

export async function terminalStart(a: {
	repo?: string; command?: string; dir?: string; shell?: ShellKind
	env?: Record<string, string>; cols?: number; rows?: number
}) {
	assertPtyEnabled()
	const repo = resolveRepo(a.repo)
	if (TERMINAL_MODE === "repo" && repo.source === "system") {
		throw new Error("TERMINAL_MODE=repo khong cho PTY tren repo system; chi ro mot repo that")
	}
	const cwd = safeResolveDir(repo.root, a.dir)
	const startArgs = {
		repo: repo.name,
		cwd,
		command: a.command,
		shell: a.shell,
		env: buildTerminalEnv(a.env, TERMINAL_INHERIT_SECRETS),
		cols: a.cols ?? 120,
		rows: a.rows ?? 30,
	}

	// Hold the exclusive repo lease for the complete PTY lifetime. Read/write/
	// resize/close calls bypass the outer registry lock and address this owner
	// session directly, so they cannot deadlock behind their own lease.
	return await new Promise((resolve, reject) => {
		let started = false
		void withLock(repo.root, "terminal_start", async () => {
			const view = startPtySession(startArgs)
			started = true
			resolve(view)
			await waitForPtySession(view.id)
		}).catch((error: unknown) => {
			if (!started) reject(error)
		})
	})
}

export const terminalWriteSchema = {
	repo: z.string().optional().describe("Ten repo cua PTY session"),
	session_id: z.string().min(1),
	data: z.string().max(PTY_MAX_INPUT_CHARS).describe("Raw input gui vao PTY; dung \\r cho Enter, \\x03 cho Ctrl+C"),
}
export async function terminalWrite(a: { repo?: string; session_id: string; data: string }) {
	assertPtyEnabled()
	const repo = resolveRepo(a.repo)
	assertPtySessionRepo(a.session_id, repo.name)
	return writePtySession(a.session_id, a.data)
}

export const terminalReadSchema = {
	repo: z.string().optional().describe("Ten repo cua PTY session"),
	session_id: z.string().min(1),
	cursor: z.number().int().min(0).optional().describe("Byte cursor tu lan doc truoc; bo trong de doc tu dau buffer hien co"),
	max_bytes: z.number().int().min(1).max(PTY_READ_MAX_BYTES).optional(),
}
export async function terminalRead(a: { repo?: string; session_id: string; cursor?: number; max_bytes?: number }) {
	assertPtyEnabled()
	const repo = resolveRepo(a.repo)
	assertPtySessionRepo(a.session_id, repo.name)
	return readPtySession(a.session_id, a.cursor, a.max_bytes)
}

export const terminalResizeSchema = {
	repo: z.string().optional().describe("Ten repo cua PTY session"),
	session_id: z.string().min(1),
	cols: z.number().int().min(20).max(500),
	rows: z.number().int().min(5).max(200),
}
export async function terminalResize(a: { repo?: string; session_id: string; cols: number; rows: number }) {
	assertPtyEnabled()
	const repo = resolveRepo(a.repo)
	assertPtySessionRepo(a.session_id, repo.name)
	return resizePtySession(a.session_id, a.cols, a.rows)
}

export const terminalCloseSchema = {
	repo: z.string().optional().describe("Ten repo cua PTY session"),
	session_id: z.string().min(1),
}
export async function terminalClose(a: { repo?: string; session_id: string }) {
	assertPtyEnabled()
	const repo = resolveRepo(a.repo)
	assertPtySessionRepo(a.session_id, repo.name)
	return closePtySession(a.session_id)
}

export const terminalListSchema = { repo: z.string().optional().describe("Ten repo (xem list_repos)") }
export async function terminalList(a: { repo?: string }) {
	assertPtyEnabled()
	const repo = resolveRepo(a.repo)
	return { repo: repo.name, sessions: listPtySessions(repo.name) }
}

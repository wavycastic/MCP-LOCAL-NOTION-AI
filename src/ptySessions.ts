import { randomUUID } from "node:crypto"
import type { IPty } from "node-pty"
import { spawn } from "node-pty"
import {
	PTY_BUFFER_BYTES,
	PTY_IDLE_TIMEOUT_MS,
	PTY_MAX_INPUT_CHARS,
	PTY_MAX_LIFETIME_MS,
	PTY_MAX_SESSIONS,
	PTY_READ_MAX_BYTES,
} from "./config.js"
import type { ShellKind } from "./terminalShell.js"
import { buildPtySpawn } from "./terminalShell.js"

export type PtyStatus = "running" | "exited" | "closed"

export type PtySessionView = {
	id: string
	repo: string
	cwd: string
	shell: ShellKind
	command_length: number
	pid: number
	status: PtyStatus
	cols: number
	rows: number
	started_at: string
	last_activity_at: string
	ended_at?: string
	exit_code?: number
	signal?: number
	buffer_base_cursor: number
	next_cursor: number
	output_truncated: boolean
}

type PtyRecord = {
	view: PtySessionView
	pty: IPty
	buffer: Buffer
	done: Promise<void>
	finish: () => void
}

const sessions = new Map<string, PtyRecord>()

function touch(rec: PtyRecord): void {
	rec.view.last_activity_at = new Date().toISOString()
}

function runningCount(): number {
	let count = 0
	for (const rec of sessions.values()) if (rec.view.status === "running") count++
	return count
}

function pruneFinished(): void {
	const maxRetained = Math.max(PTY_MAX_SESSIONS * 4, PTY_MAX_SESSIONS)
	if (sessions.size < maxRetained) return
	const finished = [...sessions.values()]
		.filter((rec) => rec.view.status !== "running")
		.sort((a, b) => a.view.last_activity_at.localeCompare(b.view.last_activity_at))
	for (const rec of finished) {
		if (sessions.size < maxRetained) break
		sessions.delete(rec.view.id)
	}
}

function appendOutput(rec: PtyRecord, data: string): void {
	const incoming = Buffer.from(data, "utf8")
	rec.buffer = Buffer.concat([rec.buffer, incoming])
	rec.view.next_cursor += incoming.length
	if (rec.buffer.length <= PTY_BUFFER_BYTES) return

	let cut = rec.buffer.length - PTY_BUFFER_BYTES
	while (cut < rec.buffer.length && (rec.buffer[cut]! & 0xc0) === 0x80) cut++
	rec.buffer = rec.buffer.subarray(cut)
	rec.view.buffer_base_cursor += cut
	rec.view.output_truncated = true
}

function viewOf(rec: PtyRecord): PtySessionView {
	return { ...rec.view }
}

export function startPtySession(args: {
	repo: string
	cwd: string
	command?: string
	shell?: ShellKind
	env: Record<string, string>
	cols: number
	rows: number
}): PtySessionView {
	pruneFinished()
	if (runningCount() >= PTY_MAX_SESSIONS) {
		throw new Error(`Da dat gioi han PTY_MAX_SESSIONS=${PTY_MAX_SESSIONS}. Dong session cu truoc khi tao session moi.`)
	}

	const spec = buildPtySpawn(args.command, args.shell)
	const pty = spawn(spec.file, spec.args, {
		name: "xterm-256color",
		cwd: args.cwd,
		env: args.env,
		cols: args.cols,
		rows: args.rows,
		useConpty: process.platform === "win32",
		// The bundled ConPTY path avoids node-pty's console-list helper race when a
		// session is closed immediately after the shell exits (AttachConsole failed).
		useConptyDll: process.platform === "win32",
	})
	const now = new Date().toISOString()
	const id = `pty-${randomUUID()}`
	let finish!: () => void
	const done = new Promise<void>((resolve) => { finish = resolve })
	const rec: PtyRecord = {
		pty,
		buffer: Buffer.alloc(0),
		done,
		finish,
		view: {
			id,
			repo: args.repo,
			cwd: args.cwd,
			shell: spec.shell,
			command_length: args.command?.length ?? 0,
			pid: pty.pid,
			status: "running",
			cols: args.cols,
			rows: args.rows,
			started_at: now,
			last_activity_at: now,
			buffer_base_cursor: 0,
			next_cursor: 0,
			output_truncated: false,
		},
	}
	sessions.set(id, rec)
	pty.onData((data) => appendOutput(rec, data))
	pty.onExit(({ exitCode, signal }) => {
		if (rec.view.status === "running") rec.view.status = "exited"
		rec.view.exit_code = exitCode
		rec.view.signal = signal
		rec.view.ended_at = new Date().toISOString()
		touch(rec)
		rec.finish()
	})
	return viewOf(rec)
}

function requireSession(id: string): PtyRecord {
	const rec = sessions.get(id)
	if (!rec) throw new Error(`Khong biet PTY session '${id}'`)
	return rec
}

export function assertPtySessionRepo(id: string, repo: string): void {
	const rec = requireSession(id)
	if (rec.view.repo !== repo) {
		throw new Error(`PTY session '${id}' thuoc repo '${rec.view.repo}', khong phai '${repo}'`)
	}
}

export function waitForPtySession(id: string): Promise<void> {
	return requireSession(id).done
}

export function writePtySession(id: string, data: string): PtySessionView {
	if (data.length > PTY_MAX_INPUT_CHARS) {
		throw new Error(`PTY input ${data.length} chars vuot PTY_MAX_INPUT_CHARS=${PTY_MAX_INPUT_CHARS}`)
	}
	const rec = requireSession(id)
	if (rec.view.status !== "running") throw new Error(`PTY session '${id}' khong con chay (status=${rec.view.status})`)
	rec.pty.write(data)
	touch(rec)
	return viewOf(rec)
}

export function readPtySession(id: string, cursor?: number, maxBytes?: number) {
	const rec = requireSession(id)
	touch(rec)
	const requested = cursor ?? rec.view.buffer_base_cursor
	if (requested > rec.view.next_cursor) {
		throw new Error(`cursor=${requested} vuot next_cursor=${rec.view.next_cursor}`)
	}
	const missedOutput = requested < rec.view.buffer_base_cursor
	const startCursor = Math.max(requested, rec.view.buffer_base_cursor)
	const start = startCursor - rec.view.buffer_base_cursor
	const limit = Math.max(1, Math.min(maxBytes ?? PTY_READ_MAX_BYTES, PTY_READ_MAX_BYTES))
	let end = Math.min(rec.buffer.length, start + limit)
	while (end > start && end < rec.buffer.length && (rec.buffer[end]! & 0xc0) === 0x80) end--
	if (end === start && end < rec.buffer.length) {
		end++
		while (end < rec.buffer.length && (rec.buffer[end]! & 0xc0) === 0x80) end++
	}
	const chunk = rec.buffer.subarray(start, end)
	const nextCursor = startCursor + chunk.length
	return {
		...viewOf(rec),
		output: chunk.toString("utf8"),
		cursor: startCursor,
		buffer_end_cursor: rec.view.next_cursor,
		next_cursor: nextCursor,
		has_more: nextCursor < rec.view.next_cursor,
		missed_output: missedOutput,
	}
}

export function resizePtySession(id: string, cols: number, rows: number): PtySessionView {
	const rec = requireSession(id)
	if (rec.view.status !== "running") throw new Error(`PTY session '${id}' khong con chay (status=${rec.view.status})`)
	rec.pty.resize(cols, rows)
	rec.view.cols = cols
	rec.view.rows = rows
	touch(rec)
	return viewOf(rec)
}

export function closePtySession(id: string): PtySessionView & { already_finished: boolean } {
	const rec = requireSession(id)
	const alreadyFinished = rec.view.status !== "running"
	if (!alreadyFinished) {
		rec.view.status = "closed"
		rec.view.ended_at = new Date().toISOString()
		try { rec.pty.kill() } catch {}
		rec.finish()
	}
	touch(rec)
	return { ...viewOf(rec), already_finished: alreadyFinished }
}

export function listPtySessions(repo?: string): PtySessionView[] {
	return [...sessions.values()]
		.map(viewOf)
		.filter((s) => !repo || s.repo === repo)
		.sort((a, b) => b.started_at.localeCompare(a.started_at))
}

export function killAllPtySessions(): number {
	let killed = 0
	for (const rec of sessions.values()) {
		if (rec.view.status !== "running") continue
		closePtySession(rec.view.id)
		killed++
	}
	return killed
}

const cleanupTimer = setInterval(() => {
	const now = Date.now()
	for (const rec of sessions.values()) {
		const idleMs = now - Date.parse(rec.view.last_activity_at)
		if (rec.view.status !== "running") {
			if (idleMs > PTY_IDLE_TIMEOUT_MS) sessions.delete(rec.view.id)
			continue
		}
		const lifetimeMs = now - Date.parse(rec.view.started_at)
		if (idleMs > PTY_IDLE_TIMEOUT_MS || lifetimeMs > PTY_MAX_LIFETIME_MS) {
			closePtySession(rec.view.id)
		}
	}
}, Math.min(30_000, Math.max(1_000, Math.floor(PTY_IDLE_TIMEOUT_MS / 4))))
cleanupTimer.unref()

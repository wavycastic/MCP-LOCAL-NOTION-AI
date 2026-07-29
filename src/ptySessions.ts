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

export type PtyStatus = "running" | "closing" | "exited" | "closed"

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
	closeTimer?: NodeJS.Timeout
	/** Waiters resolved when new data or process exit arrives */
	waiters: Set<() => void>
}

const sessions = new Map<string, PtyRecord>()

function touch(rec: PtyRecord): void {
	rec.view.last_activity_at = new Date().toISOString()
}

function runningCount(): number {
	let count = 0
	for (const rec of sessions.values()) {
		if (rec.view.status === "running" || rec.view.status === "closing") count++
	}
	return count
}

function pruneFinished(): void {
	const maxRetained = Math.max(PTY_MAX_SESSIONS * 4, PTY_MAX_SESSIONS)
	if (sessions.size < maxRetained) return
	const finished = [...sessions.values()]
		.filter((rec) => rec.view.status === "exited" || rec.view.status === "closed")
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
	if (rec.buffer.length > PTY_BUFFER_BYTES) {
		let cut = rec.buffer.length - PTY_BUFFER_BYTES
		while (cut < rec.buffer.length && (rec.buffer[cut]! & 0xc0) === 0x80) cut++
		rec.buffer = rec.buffer.subarray(cut)
		rec.view.buffer_base_cursor += cut
		rec.view.output_truncated = true
	}
	// Wake all waiters
	const ws = [...rec.waiters]
	rec.waiters.clear()
	for (const w of ws) w()
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
		waiters: new Set(),
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
		if (rec.closeTimer) clearTimeout(rec.closeTimer)
		rec.closeTimer = undefined
		rec.view.status = rec.view.status === "closing" ? "closed" : "exited"
		rec.view.exit_code = exitCode
		rec.view.signal = signal
		rec.view.ended_at = new Date().toISOString()
		touch(rec)
		// Wake waiters on exit
		const ws = [...rec.waiters]
		rec.waiters.clear()
		for (const w of ws) w()
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

/** Strip ANSI/VT escape sequences from a string */
export function stripAnsi(text: string): string {
	// CSI sequences: ESC [ ... final-byte
	// OSC sequences: ESC ] ... (ST or BEL)
	// Simple sequences: ESC char
	return text
		.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		.replace(/\x1b[^\[\]][\x20-\x2f]*[\x30-\x7e]/g, "")
		.replace(/\x1b./g, "")
}

export type AnsiMode = "raw" | "text"

function applyAnsiMode(text: string, mode: AnsiMode): string {
	return mode === "text" ? stripAnsi(text) : text
}

/**
 * Wait up to waitMs for new data at or beyond cursor, then read.
 * Returns immediately if data is already available or session has exited.
 */
export async function readPtySessionWait(
	id: string,
	cursor?: number,
	maxBytes?: number,
	waitMs?: number,
	mode: AnsiMode = "raw",
) {
	const rec = requireSession(id)
	touch(rec)
	const effectiveCursor = cursor ?? rec.view.buffer_base_cursor
	// Check if data is already available beyond the cursor
	const hasData = effectiveCursor < rec.view.next_cursor
	const isFinished = rec.view.status === "exited" || rec.view.status === "closed"
	if (!hasData && !isFinished && waitMs && waitMs > 0) {
		const cappedWait = Math.min(waitMs, 60_000)
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				rec.waiters.delete(resolve)
				resolve()
			}, cappedWait)
			timer.unref()
			rec.waiters.add(resolve)
		})
		touch(rec)
	}
	const result = readPtySessionInternal(rec, effectiveCursor, maxBytes)
	return { ...result, output: applyAnsiMode(result.output, mode) }
}

/**
 * Wait for a string/regex pattern to appear in PTY output (starting at cursor),
 * returning the matched output section, or null if timeout or session exits first.
 */
export async function waitForPtyPattern(
	id: string,
	pattern: string | RegExp,
	options: { cursor?: number; timeoutMs?: number; maxBufferBytes?: number; mode?: AnsiMode } = {},
): Promise<{ matched: true; match: string; output: string; cursor: number; next_cursor: number } | { matched: false; reason: "timeout" | "exited"; output: string; cursor: number; next_cursor: number }> {
	const rec = requireSession(id)
	touch(rec)
	const timeoutMs = Math.min(options.timeoutMs ?? 30_000, 120_000)
	const mode = options.mode ?? "raw"
	const startCursor = options.cursor ?? rec.view.buffer_base_cursor
	const deadline = Date.now() + timeoutMs

	function tryMatch(): { matched: true; match: string; output: string; cursor: number; next_cursor: number } | null {
		const slice = readPtySessionInternal(rec, startCursor, options.maxBufferBytes)
		const text = applyAnsiMode(slice.output, mode)
		const rx = typeof pattern === "string" ? null : pattern
		const strPat = typeof pattern === "string" ? pattern : null
		const found = strPat !== null ? text.includes(strPat) : rx!.test(text)
		if (!found) return null
		const matchText = strPat !== null ? strPat : (text.match(rx!))?.[0] ?? ""
		return { matched: true, match: matchText, output: text, cursor: slice.cursor, next_cursor: slice.next_cursor }
	}

	while (true) {
		const m = tryMatch()
		if (m) return m
		const isFinished = rec.view.status === "exited" || rec.view.status === "closed"
		if (isFinished) {
			// One final check after exit
			const m2 = tryMatch()
			if (m2) return m2
			const slice = readPtySessionInternal(rec, startCursor, options.maxBufferBytes)
			return { matched: false, reason: "exited", output: applyAnsiMode(slice.output, mode), cursor: slice.cursor, next_cursor: slice.next_cursor }
		}
		const remaining = deadline - Date.now()
		if (remaining <= 0) {
			const slice = readPtySessionInternal(rec, startCursor, options.maxBufferBytes)
			return { matched: false, reason: "timeout", output: applyAnsiMode(slice.output, mode), cursor: slice.cursor, next_cursor: slice.next_cursor }
		}
		// Wait for next data event
		await new Promise<void>((resolve) => {
			const wait = Math.min(remaining, 30_000)
			const timer = setTimeout(() => {
				rec.waiters.delete(resolve)
				resolve()
			}, wait)
			timer.unref()
			rec.waiters.add(resolve)
		})
		touch(rec)
	}
}

function readPtySessionInternal(rec: PtyRecord, cursor: number, maxBytes?: number) {
	const requested = cursor
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

export function readPtySession(id: string, cursor?: number, maxBytes?: number) {
	const rec = requireSession(id)
	touch(rec)
	const effectiveCursor = cursor ?? rec.view.buffer_base_cursor
	return readPtySessionInternal(rec, effectiveCursor, maxBytes)
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

export async function closePtySession(id: string): Promise<PtySessionView & { already_finished: boolean; already_closing: boolean }> {
	const rec = requireSession(id)
	const alreadyFinished = rec.view.status === "exited" || rec.view.status === "closed"
	const alreadyClosing = rec.view.status === "closing"
	if (alreadyFinished) {
		touch(rec)
		return { ...viewOf(rec), already_finished: true, already_closing: false }
	}

	if (!alreadyClosing) {
		rec.view.status = "closing"
		touch(rec)
		try {
			rec.pty.kill()
		} catch (error) {
			rec.view.status = "running"
			throw new Error(`Khong dong duoc PTY session '${id}': ${error instanceof Error ? error.message : String(error)}`)
		}
		// Normally node-pty emits onExit and releases the repo lease. If a native
		// backend fails to emit it, force the shell PID down and release after a
		// bounded grace period instead of deadlocking the repo forever.
		rec.closeTimer = setTimeout(() => {
			if (rec.view.status !== "closing") return
			try { process.kill(rec.view.pid, "SIGKILL") } catch {}
			rec.view.status = "closed"
			rec.view.ended_at = new Date().toISOString()
			touch(rec)
			rec.finish()
		}, 5_000)
		rec.closeTimer.unref()
	}

	await rec.done
	return { ...viewOf(rec), already_finished: false, already_closing: alreadyClosing }
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
		if (rec.view.status !== "running" && rec.view.status !== "closing") continue
		void closePtySession(rec.view.id).catch(() => undefined)
		killed++
	}
	return killed
}

const cleanupTimer = setInterval(() => {
	const now = Date.now()
	for (const rec of sessions.values()) {
		const idleMs = now - Date.parse(rec.view.last_activity_at)
		if (rec.view.status === "exited" || rec.view.status === "closed") {
			if (idleMs > PTY_IDLE_TIMEOUT_MS) sessions.delete(rec.view.id)
			continue
		}
		if (rec.view.status === "closing") continue
		const lifetimeMs = now - Date.parse(rec.view.started_at)
		if (idleMs > PTY_IDLE_TIMEOUT_MS || lifetimeMs > PTY_MAX_LIFETIME_MS) {
			void closePtySession(rec.view.id).catch(() => undefined)
		}
	}
}, Math.min(30_000, Math.max(1_000, Math.floor(PTY_IDLE_TIMEOUT_MS / 4))))
cleanupTimer.unref()

/**
 * Chay sub-agent qua Antigravity CLI (`agy`) o che do headless.
 *
 * Truoc day module nay doc thang SQLite cua tung hoi thoai roi tu giai protobuf
 * de doan xem sub-agent dang lam gi va da xong chua. Cach do sai ba lan lien
 * tiep, vi trong DB khong co tin hieu ket thuc dang tin cay.
 *
 * CLI cho san thu do: `--output-format stream-json` phat NDJSON gom init,
 * step_update (kem tool_info va usage) va dung mot su kien result mang status
 * that (SUCCESS/ERROR/CANCELED/INTERRUPTED/INVALID/WAITING/RUNNING).
 */
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	ANTIGRAVITY_CLI_BIN,
	ANTIGRAVITY_INTERACTIVE,
	ANTIGRAVITY_MODEL,
	ANTIGRAVITY_SKIP_PERMISSIONS,
	ANTIGRAVITY_START_TIMEOUT_MS,
	ANTIGRAVITY_TASK_TIMEOUT_MS,
} from "../config.js"

export type EventKind = "user" | "agent" | "tool" | "checkpoint" | "other"

export type AgentEvent = {
	/** Thu tu tang dan trong phien; dung lam moc cho since_seq. */
	seq: number
	step: number
	kind: EventKind
	/** ACTIVE khi buoc bat dau, DONE khi xong, ERROR khi tool that bai. */
	state: string
	tool?: string
	params?: string
	output?: string
	text?: string
	error?: string
	duration_s?: number
}

export type Session = {
	id: string
	repo: string
	cwd: string
	model: string
	/** "running" khi tien trinh con song; sau do la status tu su kien result. */
	status: string
	events: AgentEvent[]
	response: string
	error?: string
	usage?: Record<string, number>
	turns: number
	started_at: string
	ended_at?: string
}

type Live = Session & {
	proc?: ChildProcess
	windowProc?: ChildProcess
	stderr: string
	sawResult: boolean
	logPath?: string
	windowOpened?: boolean
	agentHeaderPrinted?: boolean
}

const sessions = new Map<string, Live>()

/** Giu lai vai phien gan nhat de con poll duoc; phien cu bi don. */
const MAX_SESSIONS = 24

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function clip(s: string, n = 240): string {
	const one = s.replace(/\s+/g, " ").trim()
	return one.length > n ? `${one.slice(0, n)}...` : one
}

function push(live: Live, e: Omit<AgentEvent, "seq">): void {
	live.events.push({ seq: live.events.length, ...e })
}

function kindOf(t: string | undefined): EventKind {
	switch (t) {
		case "user_input":
			return "user"
		case "agent_response":
			return "agent"
		case "tool":
			return "tool"
		case "checkpoint":
			return "checkpoint"
		default:
			return "other"
	}
}

type StreamEvent = {
	event?: string
	conversation_id?: string
	init?: { cwd?: string; model?: string; permission_mode?: string }
	step_update?: {
		conversation_id?: string
		step_index?: number
		state?: string
		step_type?: string
		tool_name?: string
		text_delta?: string
		duration_seconds?: number
		tool_info?: {
			name?: string
			parameters?: unknown
			output?: string
			error?: { type?: string; message?: string }
		}
	}
	result?: {
		conversation_id?: string
		status?: string
		response?: string
		error?: string
		num_turns?: number
		usage?: Record<string, number>
	}
}

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	brightCyan: "\x1b[1;36m",
	yellow: "\x1b[33m",
	brightYellow: "\x1b[1;33m",
	green: "\x1b[32m",
	brightGreen: "\x1b[1;32m",
	magenta: "\x1b[35m",
	brightMagenta: "\x1b[1;35m",
	red: "\x1b[31m",
	brightRed: "\x1b[1;31m",
	gray: "\x1b[90m",
	white: "\x1b[1;37m",
}

function appendLiveLog(live: Live, text: string): void {
	if (!live.logPath) return
	try {
		appendFileSync(live.logPath, text, "utf8")
	} catch {
		// Ignore write errors
	}
}

function ensureLiveWindow(live: Live, cwd: string, prompt: string): void {
	if (!live.id) return
	if (!live.logPath) {
		const cleanId = live.id.replace(/[^a-zA-Z0-9_-]/g, "_")
		const logFile = join(tmpdir(), `antigravity_${cleanId}.log`)
		live.logPath = logFile
		if (!existsSync(logFile)) {
			const header =
				`\n  ${ANSI.gray}──────────────────────────────────────────────────────────────────────────────${ANSI.reset}\n` +
				`  ${ANSI.brightCyan}🤖  ANTIGRAVITY SUB-AGENT${ANSI.reset} ${ANSI.gray}·  ${live.id.slice(0, 8)}  ·  ${cwd}${ANSI.reset}\n` +
				`  ${ANSI.gray}──────────────────────────────────────────────────────────────────────────────${ANSI.reset}\n`
			writeFileSync(logFile, header, "utf8")
		}
	}

	const promptBlock =
		`\n  ${ANSI.brightYellow}❯ USER PROMPT${ANSI.reset}\n` +
		`    ${ANSI.white}${prompt.replace(/\n/g, "\n    ")}${ANSI.reset}\n`

	appendLiveLog(live, promptBlock)
	live.agentHeaderPrinted = false

	if (live.windowProc && live.windowProc.exitCode === null && !live.windowProc.killed) {
		return
	}

	try {
		if (process.platform === "win32") {
			const title = `Antigravity Live Viewer (${live.id.slice(0, 8)})`
			const psCmd = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $host.ui.RawUI.WindowTitle = '${title}'; Get-Content -Path '${live.logPath}' -Wait -Tail 40`
			const wProc = spawn("powershell.exe", ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", psCmd], {
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			})
			wProc.unref()
			live.windowProc = wProc
			live.windowOpened = true
		} else if (process.platform === "darwin") {
			const wProc = spawn("open", ["-a", "Terminal", live.logPath], { detached: true, stdio: "ignore" })
			wProc.unref()
			live.windowProc = wProc
			live.windowOpened = true
		} else {
			const wProc = spawn("x-terminal-emulator", ["-e", `tail -f "${live.logPath}"`], { detached: true, stdio: "ignore" })
			wProc.unref()
			live.windowProc = wProc
			live.windowOpened = true
		}
	} catch {
		// Ignore window open errors
	}
}

function handleLine(live: Live, line: string): void {
	let ev: StreamEvent
	try {
		ev = JSON.parse(line) as StreamEvent
	} catch {
		// Dong khong phai JSON (banner, canh bao) — bo qua.
		return
	}

	const id = ev.conversation_id ?? ev.step_update?.conversation_id ?? ev.result?.conversation_id
	if (id && !live.id) live.id = id

	if (ev.event === "init" && ev.init) {
		if (ev.init.model) live.model = ev.init.model
		push(live, {
			step: -1,
			kind: "other",
			state: "DONE",
			text: `init: ${ev.init.permission_mode ?? "?"} @ ${ev.init.cwd ?? live.cwd}`,
		})
		appendLiveLog(
			live,
			`  ${ANSI.cyan}⚡ SYSTEM${ANSI.reset}  ${ANSI.gray}${live.model}  ·  ${ev.init.permission_mode ?? "default"}${ANSI.reset}\n`,
		)
		return
	}

	if (ev.event === "step_update" && ev.step_update) {
		const su = ev.step_update
		const info = su.tool_info
		const kind = kindOf(su.step_type)
		const tool = su.tool_name ?? info?.name
		if (su.text_delta) {
			live.response += su.text_delta
			if (!live.agentHeaderPrinted) {
				appendLiveLog(live, `\n  ${ANSI.brightGreen}◆ SUB-AGENT${ANSI.reset}\n    ${ANSI.white}`)
				live.agentHeaderPrinted = true
			}
			appendLiveLog(live, su.text_delta.replace(/\n/g, "\n    "))
		}
		if (tool && su.state === "DONE") {
			const toolLine =
				`\n  ${ANSI.brightMagenta}🛠️  TOOL${ANSI.reset} ${ANSI.brightYellow}${tool}${ANSI.reset} ` +
				`${ANSI.gray}${info?.parameters ? clip(JSON.stringify(info.parameters), 100) : ""}${ANSI.reset}\n`
			appendLiveLog(live, toolLine)
		}
		// step_type "unknown" khong mang thong tin gi — khong lam ban timeline.
		if (kind === "other" && !su.text_delta && !tool) return
		const e: Omit<AgentEvent, "seq"> = {
			step: su.step_index ?? -1,
			kind,
			state: su.state ?? "DONE",
		}
		if (tool) e.tool = tool
		if (info?.parameters !== undefined) e.params = clip(JSON.stringify(info.parameters))
		if (info?.output) e.output = clip(info.output)
		if (su.text_delta) e.text = clip(su.text_delta, 400)
		if (info?.error?.message) e.error = clip(info.error.message)
		if (typeof su.duration_seconds === "number") e.duration_s = su.duration_seconds
		push(live, e)
		return
	}

	if (ev.event === "result" && ev.result) {
		live.sawResult = true
		live.status = ev.result.status ?? "SUCCESS"
		if (ev.result.response) live.response = ev.result.response
		if (ev.result.error) live.error = clip(ev.result.error, 600)
		if (ev.result.usage) live.usage = ev.result.usage
		if (typeof ev.result.num_turns === "number") live.turns = ev.result.num_turns
		push(live, { step: -1, kind: "other", state: live.status, text: `result: ${live.status}` })

		if (live.agentHeaderPrinted) {
			appendLiveLog(live, ANSI.reset)
		}
		const statusColor = live.status === "SUCCESS" ? ANSI.brightGreen : ANSI.brightRed
		appendLiveLog(
			live,
			`\n  ${statusColor}✔ ${live.status}${ANSI.reset}  ${ANSI.gray}(Turns: ${live.turns})${ANSI.reset}\n` +
				`  ${ANSI.gray}──────────────────────────────────────────────────────────────────────────────${ANSI.reset}\n`,
		)
	}
}

function snapshot(l: Live): Session {
	const s: Session = {
		id: l.id,
		repo: l.repo,
		cwd: l.cwd,
		model: l.model,
		status: l.status,
		events: l.events,
		response: l.response,
		turns: l.turns,
		started_at: l.started_at,
	}
	if (l.error) s.error = l.error
	if (l.usage) s.usage = l.usage
	if (l.ended_at) s.ended_at = l.ended_at
	return s
}

function trimSessions(): void {
	if (sessions.size <= MAX_SESSIONS) return
	const done = [...sessions.values()].filter((s) => !s.proc).sort((a, b) => a.started_at.localeCompare(b.started_at))
	for (const s of done) {
		if (sessions.size <= MAX_SESSIONS) break
		sessions.delete(s.id)
	}
}

export type StartArgs = {
	prompt: string
	cwd: string
	repo: string
	model?: string
	/** Co thi chay `--conversation <id>`, tuc la noi tiep hoi thoai cu. */
	conversationId?: string
	skipPermissions?: boolean
	timeoutMs?: number
	/** Mo cua so Terminal hien thi log live truoc mat nguoi dung. */
	interactive?: boolean
}

function argvFor(a: StartArgs): string[] {
	const argv = ["-p", a.prompt, "--output-format", "stream-json", "--model", a.model ?? ANTIGRAVITY_MODEL]
	if (a.conversationId) argv.push("--conversation", a.conversationId)
	if (a.skipPermissions ?? ANTIGRAVITY_SKIP_PERMISSIONS) argv.push("--dangerously-skip-permissions")
	argv.push("--print-timeout", `${Math.ceil((a.timeoutMs ?? ANTIGRAVITY_TASK_TIMEOUT_MS) / 1000)}s`)
	return argv
}

/**
 * Bat mot lan chay va tra ve NGAY khi biet conversation_id (su kien init).
 * Tien trinh chay tiep o nen; doc tien do bang pollSession. Hien thi cua so live neu interactive=true.
 */
export async function startRun(a: StartArgs): Promise<Session> {
	if (!existsSync(ANTIGRAVITY_CLI_BIN)) {
		throw new Error(
			`khong tim thay Antigravity CLI: ${ANTIGRAVITY_CLI_BIN}. ` +
				`Cai bang installer chinh chu roi dat ANTIGRAVITY_CLI_BIN neu duong dan khac`,
		)
	}

	const known = a.conversationId ? sessions.get(a.conversationId) : undefined
	if (known?.proc) {
		if (known.proc.exitCode !== null || known.proc.killed) {
			delete known.proc
		} else {
			const waitStart = Date.now()
			while (known.proc && Date.now() - waitStart < 3000) {
				if (known.proc.exitCode !== null || known.proc.killed) {
					delete known.proc
					break
				}
				await sleep(100)
			}
			if (known.proc) {
				throw new Error(`hoi thoai ${a.conversationId} dang chay — doi no ket thuc luot roi hay gui tiep`)
			}
		}
	}

	const live: Live =
		known ??
		({
			id: a.conversationId ?? "",
			repo: a.repo,
			cwd: a.cwd,
			model: a.model ?? ANTIGRAVITY_MODEL,
			status: "running",
			events: [],
			response: "",
			turns: 0,
			started_at: new Date().toISOString(),
			stderr: "",
			sawResult: false,
		} satisfies Live)

	live.status = "running"
	live.sawResult = false
	live.stderr = ""
	delete live.error
	delete live.ended_at

	const proc = spawn(ANTIGRAVITY_CLI_BIN, argvFor(a), { cwd: a.cwd, windowsHide: true })
	live.proc = proc

	let buf = ""
	proc.stdout?.setEncoding("utf8")
	proc.stdout?.on("data", (chunk: string) => {
		buf += chunk
		let nl = buf.indexOf("\n")
		while (nl >= 0) {
			const line = buf.slice(0, nl).trim()
			buf = buf.slice(nl + 1)
			if (line) handleLine(live, line)
			nl = buf.indexOf("\n")
		}
	})
	proc.stderr?.setEncoding("utf8")
	proc.stderr?.on("data", (chunk: string) => {
		live.stderr = `${live.stderr}${chunk}`.slice(-4000)
	})
	proc.on("error", (err: Error) => {
		delete live.proc
		live.status = "ERROR"
		live.error = err.message
		appendLiveLog(live, `\n[Error]: ${err.message}\n`)
	})
	proc.on("close", (code: number | null) => {
		delete live.proc
		live.ended_at = new Date().toISOString()
		if (live.sawResult) return
		// Khong co su kien result: thuong la bi tu choi quyen, hoac agy chet som.
		live.status = code === 0 ? "SUCCESS" : "ERROR"
		if (code !== 0 && !live.error) live.error = clip(live.stderr, 600) || `agy thoat voi ma ${String(code)}`
		appendLiveLog(live, `\n[Result]: ${live.status}\n`)
	})

	const deadline = Date.now() + ANTIGRAVITY_START_TIMEOUT_MS
	while (!live.id && Date.now() < deadline && live.proc) {
		await sleep(100)
	}
	if (!live.id) {
		proc.kill()
		throw new Error(
			`agy khong phat su kien init trong ${ANTIGRAVITY_START_TIMEOUT_MS}ms. ` +
				`stderr: ${clip(live.stderr, 300) || "(trong)"}`,
		)
	}

	const useInteractive = a.interactive ?? ANTIGRAVITY_INTERACTIVE
	if (useInteractive) {
		ensureLiveWindow(live, a.cwd, a.prompt)
	}

	sessions.set(live.id, live)
	trimSessions()
	return snapshot(live)
}

/**
 * Cho den khi co su kien moi hon sinceSeq, hoac tien trinh ket thuc, hoac het
 * waitMs. Tra ve trang thai hien tai du cho theo cach nao.
 */
export async function pollSession(id: string, sinceSeq: number, waitMs: number): Promise<Session> {
	const live = sessions.get(id)
	if (!live) {
		throw new Error(
			`khong biet hoi thoai ${id}. Chi theo doi duoc phien do server nay spawn; ` +
				`khoi dong lai server la mat. Xem lai lich su bang: agy --conversation ${id}`,
		)
	}
	const deadline = Date.now() + waitMs
	while (Date.now() < deadline) {
		if (live.events.length - 1 > sinceSeq) break
		if (!live.proc) break
		await sleep(300)
	}
	return snapshot(live)
}

export function getSession(id: string): Session | undefined {
	const live = sessions.get(id)
	return live ? snapshot(live) : undefined
}

export function listSessions(): Session[] {
	return [...sessions.values()].map(snapshot)
}

export function stopSession(id: string): boolean {
	const live = sessions.get(id)
	if (!live?.proc) return false
	live.proc.kill()
	live.status = "CANCELED"
	return true
}

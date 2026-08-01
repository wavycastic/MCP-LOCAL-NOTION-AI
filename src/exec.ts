import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { EXEC_TIMEOUT_MS, MAX_OUTPUT } from "./config.js"
import { FULL_ACCESS_ROOT } from "./security/paths.js"

export type ExecResult = {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
	outputTruncated: boolean
	outputBytesSeen: number
}

function resolveCmd(cmd: string): string {
	if (process.platform !== "win32") return cmd
	if (cmd.endsWith(".exe") || cmd.endsWith(".cmd") || cmd.endsWith(".bat")) return cmd

	const pathDirs = (process.env.PATH ?? "").split(";").filter(Boolean)
	for (const ext of [".cmd", ".bat", ".exe"]) {
		if (cmd.includes("/") || cmd.includes("\\")) {
			if (existsSync(cmd + ext)) return cmd + ext
		} else {
			for (const dir of pathDirs) {
				// Tra ve duong dan DAY DU. Truoc day tra ve ten tran (`cmd + ext`) sau khi
				// da ton cong quet PATH, de spawn quet lai lan hai — vua lam thua viec, vua
				// co the resolve ra file khac neu PATH doi giua hai lan quet.
				const full = join(dir, cmd + ext)
				if (existsSync(full)) return full
			}
		}
	}
	return cmd
}

const WIN_BUILTINS = new Set(["echo", "dir", "type", "cls"])
const CMD_META = /[&|<>^"%\r\n]/

const WIN_ENV_PASSTHROUGH = [
	"SystemRoot",
	"windir",
	"ComSpec",
	"PATHEXT",
	"SystemDrive",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
]

const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL|AUTH)/i

/**
 * Bien moi truong client KHONG duoc ghi de.
 *
 * `env` tu tool terminal/PTY duoc spread SAU cac gia tri mac dinh trong `childEnv`,
 * nen truoc day `{ PATH: "C:\\evil" }` doi duoc noi spawn di tim binary: goi `git`
 * nhung chay `C:\evil\git.exe`. NODE_OPTIONS / LD_PRELOAD / DYLD_INSERT_LIBRARIES con
 * te hon — chung nap code vao tien trinh con ma khong can doi ten lenh nao ca.
 *
 * SECRET_KEY_PATTERN loc thu di RA; danh sach nay chan thu duoc dua VAO.
 */
const PROTECTED_ENV_KEYS = new Set([
	"PATH",
	"PATHEXT",
	"COMSPEC",
	"NODE_OPTIONS",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"ELECTRON_RUN_AS_NODE",
	"MCP_TOKEN",
])

function sanitizeExtraEnv(extraEnv?: Record<string, string>): Record<string, string> {
	if (!extraEnv) return {}
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(extraEnv)) {
		if (PROTECTED_ENV_KEYS.has(k.toUpperCase())) continue
		out[k] = v
	}
	return out
}

function childEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		LANG: "C",
		DOTNET_CLI_TELEMETRY_OPTOUT: "1",
		DOTNET_NOLOGO: "1",
		GIT_TERMINAL_PROMPT: "0",
		...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {}),
		...sanitizeExtraEnv(extraEnv),
	}
	if (process.env.HOME) env.HOME = process.env.HOME

	if (process.platform === "win32") {
		for (const k of WIN_ENV_PASSTHROUGH) {
			const v = process.env[k]
			if (v !== undefined && env[k] === undefined) env[k] = v
		}
		if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE
	}

	delete env.MCP_TOKEN
	return env
}

export function buildTerminalEnv(extraEnv?: Record<string, string>, inheritSecrets = false): Record<string, string> {
	if (extraEnv) {
		const keys = Object.keys(extraEnv)
		if (keys.length > 100) throw new Error("Too many environment variables (max 100 entries allowed)")
		for (const [k, v] of Object.entries(extraEnv)) {
			if (k.length > 200) throw new Error(`Environment key '${k.slice(0, 20)}...' exceeds 200 characters limit`)
			if (v.length > 4000) throw new Error(`Environment value for '${k}' exceeds 4000 characters limit`)
			if (PROTECTED_ENV_KEYS.has(k.toUpperCase())) {
				throw new Error(
					`khong duoc ghi de bien moi truong '${k}': no quyet dinh binary nao duoc nap. ` +
						`Neu can chay mot binary cu the, dat duong dan day du ngay trong 'command' ` +
						`thay vi doi PATH`,
				)
			}
		}
	}

	const base = childEnv(extraEnv)
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(base)) {
		if (v === undefined) continue
		if (!inheritSecrets && SECRET_KEY_PATTERN.test(k)) continue
		out[k] = v
	}
	delete out.MCP_TOKEN
	return out
}

export function killTree(p: ChildProcess): void {
	try {
		p.stdout?.destroy()
		p.stderr?.destroy()
	} catch {}
	if (process.platform === "win32" && p.pid) {
		try {
			const k = spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" })
			k.on("error", () => p.kill("SIGKILL"))
			return
		} catch {
			// fallthrough
		}
	}
	try {
		p.kill("SIGKILL")
	} catch {}
}

export function run(
	argv: string[],
	opts: {
		cwd: string
		timeoutMs?: number
		maxOutputBytes?: number
		onSpawn?: (p: ChildProcess) => void
		env?: Record<string, string>
	},
): Promise<ExecResult> {
	const [rawCmd, ...rawArgs] = argv
	if (!rawCmd) throw new Error("argv rong")

	const cwd0 = opts.cwd === FULL_ACCESS_ROOT ? (process.env.FULL_ACCESS_CWD ?? process.cwd()) : opts.cwd
	if (!existsSync(cwd0)) {
		throw new Error(
			`cwd khong ton tai: "${cwd0}" (repo root khong hop le). ` +
				`Loi spawn ENOENT o day la do cwd, khong phai do thieu "${rawCmd}"`,
		)
	}

	const resolved = resolveCmd(rawCmd)
	const viaCmd =
		process.platform === "win32" &&
		(resolved.endsWith(".cmd") || resolved.endsWith(".bat") || WIN_BUILTINS.has(rawCmd.toLowerCase()))

	if (viaCmd) {
		for (const a of rawArgs) {
			if (CMD_META.test(a)) {
				throw new Error(
					`tham so "${a}" chua ky tu ma cmd.exe se dien giai (& | < > ^ " %). ` +
						`Tu choi chay "${rawCmd}" de khong bien tham so thanh lenh thu hai`,
				)
			}
		}
	}

	const cmd = viaCmd ? process.env.ComSpec || "cmd.exe" : resolved
	const args = viaCmd ? ["/d", "/s", "/c", rawCmd, ...rawArgs] : rawArgs
	const configuredLimit = opts.maxOutputBytes ?? MAX_OUTPUT
	const maxOutput = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : MAX_OUTPUT

	return new Promise((res, rej) => {
		const p = spawn(cmd, args, { cwd: cwd0, shell: false, stdio: ["ignore", "pipe", "pipe"], env: childEnv(opts.env) })
		opts.onSpawn?.(p)

		const outChunks: Buffer[] = []
		const errChunks: Buffer[] = []
		let capturedBytes = 0
		let outputBytesSeen = 0
		let timedOut = false
		let resolved = false

		const capture = (target: Buffer[], data: Buffer | string) => {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
			outputBytesSeen += buf.length
			const remaining = maxOutput - capturedBytes
			if (remaining <= 0) return
			const part = buf.subarray(0, Math.min(remaining, buf.length))
			target.push(part)
			capturedBytes += part.length
		}

		let exitCode: number | null = null
		let exitTimer: NodeJS.Timeout | null = null

		const finish = (code: number | null) => {
			if (resolved) return
			resolved = true
			clearTimeout(t)
			if (exitTimer) clearTimeout(exitTimer)
			res({
				code,
				stdout: Buffer.concat(outChunks).toString("utf8"),
				stderr: Buffer.concat(errChunks).toString("utf8"),
				timedOut,
				outputTruncated: outputBytesSeen > capturedBytes,
				outputBytesSeen,
			})
		}

		const t = setTimeout(() => {
			timedOut = true
			killTree(p)
			setTimeout(() => {
				try { p.stdout?.destroy() } catch {}
				try { p.stderr?.destroy() } catch {}
				finish(exitCode ?? -1)
			}, 1500).unref()
		}, opts.timeoutMs ?? EXEC_TIMEOUT_MS)

		p.stdout?.on("data", (d) => capture(outChunks, d))
		p.stderr?.on("data", (d) => capture(errChunks, d))
		p.on("error", (e) => {
			if (resolved) return
			resolved = true
			clearTimeout(t)
			if (exitTimer) clearTimeout(exitTimer)
			rej(e)
		})
		p.on("exit", (code) => {
			if (exitCode === null) exitCode = code
			exitTimer = setTimeout(() => {
				try { p.stdout?.destroy() } catch {}
				try { p.stderr?.destroy() } catch {}
				finish(exitCode)
			}, 500)
			exitTimer.unref()
		})
		p.on("close", (code) => {
			finish(code)
		})
	})
}

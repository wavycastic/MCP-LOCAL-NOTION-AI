import { spawn } from "node:child_process"
import { EXEC_TIMEOUT_MS, MAX_OUTPUT } from "./config.js"

export type ExecResult = {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

/**
 * Chay argv co dinh, khong qua shell, trong cwd la root cua MOT repo.
 * cwd la tham so bat buoc: multi-repo nen khong con "thu muc mac dinh" nao dung.
 */
export function run(
	argv: string[],
	opts: { cwd: string; timeoutMs?: number },
): Promise<ExecResult> {
	const [cmd, ...args] = argv
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, {
			cwd: opts.cwd,
			shell: false, // BAT BUOC
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: "C",
				DOTNET_CLI_TELEMETRY_OPTOUT: "1",
				DOTNET_NOLOGO: "1",
				GIT_TERMINAL_PROMPT: "0", // khong treo cho nhap credential
			},
		})
		let out = ""
		let err = ""
		let timedOut = false
		const t = setTimeout(() => {
			timedOut = true
			p.kill("SIGKILL")
		}, opts.timeoutMs ?? EXEC_TIMEOUT_MS)

		p.stdout.on("data", (d) => {
			if (out.length < MAX_OUTPUT) out += d.toString()
		})
		p.stderr.on("data", (d) => {
			if (err.length < MAX_OUTPUT) err += d.toString()
		})
		p.on("error", (e) => {
			clearTimeout(t)
			rej(e)
		})
		p.on("close", (code) => {
			clearTimeout(t)
			res({
				code,
				stdout: out.slice(0, MAX_OUTPUT),
				stderr: err.slice(0, MAX_OUTPUT),
				timedOut,
			})
		})
	})
}

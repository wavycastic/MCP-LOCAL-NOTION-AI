import { spawn } from "node:child_process"
import { EXEC_TIMEOUT_MS, MAX_OUTPUT, REPO_ROOT } from "./config.js"

export type ExecResult = {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

export function run(
	argv: string[],
	opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
	const [cmd, ...args] = argv
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, {
			cwd: opts.cwd ?? REPO_ROOT,
			shell: false, // BAT BUOC
			env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" },
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

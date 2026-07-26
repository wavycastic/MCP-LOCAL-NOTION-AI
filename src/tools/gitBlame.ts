import { z } from "zod"
import { run } from "../exec.js"
import { safeResolve } from "../security/paths.js"

export const gitBlameSchema = {
	path: z.string().describe("File can blame (tuong doi repo root)"),
	line_start: z.number().int().min(1).optional(),
	line_end: z.number().int().min(1).optional(),
}

export async function gitBlame(a: {
	path: string
	line_start?: number
	line_end?: number
}) {
	safeResolve(a.path) // chroot + deny-list
	const argv = ["git", "--no-pager", "blame", "--line-porcelain"]
	if (a.line_start) {
		const end = a.line_end ?? a.line_start + 200
		argv.push("-L", `${a.line_start},${end}`)
	}
	argv.push("--", a.path)
	const r = await run(argv, { timeoutMs: 60_000 })
	return {
		path: a.path,
		exit_code: r.code,
		blame: r.stdout.slice(0, 60_000),
		stderr: r.stderr.slice(0, 4_000),
	}
}

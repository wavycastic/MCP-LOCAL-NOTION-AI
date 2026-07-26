import { z } from "zod"
import { run } from "../exec.js"
import { safeResolve } from "../security/paths.js"

export const gitDiffSchema = {
	path: z.string().optional().describe("Gioi han diff vao 1 file/thu muc (tuong doi repo root)"),
	staged: z.boolean().optional().describe("true: diff --cached"),
	stat_only: z.boolean().optional().describe("true: chi tra --stat, khong tra patch"),
}

export async function gitDiff(a: {
	path?: string
	staged?: boolean
	stat_only?: boolean
}) {
	const argv = ["git", "--no-pager", "diff", "--no-color"]
	if (a.staged) argv.push("--cached")
	if (a.stat_only) argv.push("--stat")
	if (a.path) {
		safeResolve(a.path) // validate, khong dung ket qua: git can path tuong doi
		argv.push("--", a.path)
	}
	const r = await run(argv, { timeoutMs: 60_000 })
	return {
		exit_code: r.code,
		truncated: r.stdout.length >= 80_000,
		diff: r.stdout.slice(0, 80_000),
	}
}

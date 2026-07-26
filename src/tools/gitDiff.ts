import { z } from "zod"
import { run } from "../exec.js"
import { resolveRepo } from "../repos.js"
import { safeResolve } from "../security/paths.js"

export const gitDiffSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	path: z.string().optional().describe("Gioi han diff vao 1 file/thu muc (tuong doi repo root)"),
	staged: z.boolean().optional().describe("true: diff --cached"),
	stat_only: z.boolean().optional().describe("true: chi tra --stat, khong tra patch"),
}

export async function gitDiff(a: {
	repo?: string
	path?: string
	staged?: boolean
	stat_only?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const argv = ["git", "--no-pager", "diff", "--no-color"]
	if (a.staged) argv.push("--cached")
	if (a.stat_only) argv.push("--stat")
	if (a.path) {
		safeResolve(repo.root, a.path) // validate; git can path tuong doi nen khong dung ket qua
		argv.push("--", a.path)
	}
	const r = await run(argv, { cwd: repo.root, timeoutMs: 60_000 })
	return {
		repo: repo.name,
		exit_code: r.code,
		truncated: r.stdout.length >= 80_000,
		diff: r.stdout.slice(0, 80_000),
	}
}

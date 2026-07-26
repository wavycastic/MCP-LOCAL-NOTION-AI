import { z } from "zod"
import { run } from "../exec.js"
import { resolveRepo } from "../repos.js"
import { safeResolve } from "../security/paths.js"

export const gitLogSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	max_count: z.number().int().min(1).max(50).optional(),
	path: z.string().optional().describe("Chi lay commit cham vao path nay"),
	stat: z.boolean().optional().describe("Kem --stat de thay file nao doi"),
}

export async function gitLog(a: {
	repo?: string
	max_count?: number
	path?: string
	stat?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const argv = [
		"git",
		"--no-pager",
		"log",
		"--no-color",
		"--date=iso",
		"--pretty=format:%h | %ad | %an | %s",
		"-n",
		String(a.max_count ?? 20),
	]
	if (a.stat) argv.push("--stat")
	if (a.path) {
		safeResolve(repo.root, a.path)
		argv.push("--", a.path)
	}
	const r = await run(argv, { cwd: repo.root, timeoutMs: 60_000 })
	return { repo: repo.name, exit_code: r.code, log: r.stdout.slice(0, 40_000) }
}

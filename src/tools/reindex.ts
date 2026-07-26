import { z } from "zod"
import { run } from "../exec.js"
import { resolveRepo } from "../repos.js"

export const reindexSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
}

// Khong co `git reset --hard` o day. Local la nguon su that.
export async function reindex(a: { repo?: string }) {
	const repo = resolveRepo(a.repo)
	const r = await run([...repo.reindex], { cwd: repo.root, timeoutMs: 1_800_000 })
	return {
		repo: repo.name,
		command: repo.reindex.join(" "),
		exit_code: r.code,
		timed_out: r.timedOut,
		output: r.stdout.slice(-20_000),
	}
}

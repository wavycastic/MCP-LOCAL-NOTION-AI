import { z } from "zod"
import { run } from "../exec.js"
import { currentBranch } from "../git.js"
import { resolveRepo } from "../repos.js"

export const gitStatusSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
}

export async function gitStatus(a: { repo?: string }) {
	const repo = resolveRepo(a.repo)
	const branch = await currentBranch(repo)
	const r = await run(["git", "status", "--porcelain=v1", "--branch"], {
		cwd: repo.root,
		timeoutMs: 30_000,
	})
	return {
		repo: repo.name,
		branch,
		writable: repo.write && branch.startsWith(repo.branchPrefix),
		exit_code: r.code,
		dirty: r.stdout.split("\n").some((l) => l.trim() && !l.startsWith("##")),
		status: r.stdout.slice(0, 40_000),
	}
}

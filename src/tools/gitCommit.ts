import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"

export const gitCommitSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	message: z.string().min(3).max(2000),
}

export async function gitCommit(a: { repo?: string; message: string }) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	await run(["git", "add", "-A"], { cwd: repo.root, timeoutMs: 60_000 })
	// spawn khong qua shell nen truyen -m truc tiep la an toan.
	const r = await run(["git", "commit", "-m", a.message], {
		cwd: repo.root,
		timeoutMs: 60_000,
	})
	const sha = await run(["git", "rev-parse", "--short", "HEAD"], {
		cwd: repo.root,
		timeoutMs: 15_000,
	})
	return {
		repo: repo.name,
		branch,
		sha: sha.stdout.trim(),
		exit_code: r.code,
		output: r.stdout + r.stderr,
	}
}

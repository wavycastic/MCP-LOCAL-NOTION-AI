import { z } from "zod"
import { ALLOW_PUSH, GIT_REMOTE } from "../config.js"
import { run } from "../exec.js"
import { assertWritableBranch, isDirty } from "../git.js"
import { resolveRepo } from "../repos.js"

export const gitPushSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
}

/**
 * Push branch agent/* len remote. Khong bao gio --force, khong bao gio push nhanh khac.
 * Tat mac dinh: dat ALLOW_PUSH=true trong .env de bat.
 */
export async function gitPush(a: { repo?: string }) {
	if (!ALLOW_PUSH)
		throw new Error("push dang bi tat. Dat ALLOW_PUSH=true trong .env neu muon bat")

	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	if (await isDirty(repo))
		throw new Error("working tree con thay doi chua commit — goi git_commit truoc")

	const r = await run(["git", "push", "--set-upstream", GIT_REMOTE, branch], {
		cwd: repo.root,
		timeoutMs: 300_000,
	})
	if (r.code !== 0)
		throw new Error(`git push that bai: ${r.stderr.trim() || r.stdout.trim()}`)
	return {
		repo: repo.name,
		remote: GIT_REMOTE,
		branch,
		exit_code: r.code,
		output: (r.stdout + r.stderr).slice(-8_000),
	}
}

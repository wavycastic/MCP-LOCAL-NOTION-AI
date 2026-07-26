import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"
import { isDeniedRelPath } from "../security/paths.js"

export const gitCommitSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	message: z.string().min(3).max(2000),
}

export async function gitCommit(a: { repo?: string; message: string }) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)

	await run(["git", "add", "-A"], { cwd: repo.root, timeoutMs: 60_000 })

	// `git add -A` stage MOI thu trong working tree, ke ca file ma deny-list khong
	// cho doc. Deny-list chi chan doc thi chua du: phai chan ca duong ra qua commit.
	// Unstage roi bao loi, de nguyen working tree cho nguoi dung tu xu ly.
	const staged = await run(["git", "diff", "--cached", "--name-only"], {
		cwd: repo.root,
		timeoutMs: 30_000,
	})
	const denied = staged.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.filter(isDeniedRelPath)

	if (denied.length > 0) {
		// reset theo path: chi bo stage, KHONG doi working tree (khong --hard).
		await run(["git", "reset", "--", ...denied], { cwd: repo.root, timeoutMs: 30_000 })
		throw new Error(
			`tu choi commit: ${denied.length} file thuoc deny-list dang cho commit (${denied.join(", ")}). ` +
				`Da bo stage. Them chung vao .gitignore hoac di chuyen ra ngoai repo roi thu lai`,
		)
	}

	// spawn khong qua shell nen truyen -m truc tiep la an toan.
	const r = await run(["git", "commit", "-m", a.message], {
		cwd: repo.root,
		timeoutMs: 60_000,
	})
	if (r.code !== 0)
		throw new Error(
			`git commit that bai (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
		)

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

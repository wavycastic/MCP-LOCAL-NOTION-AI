import { z } from "zod"
import { run } from "../exec.js"
import { branchAllowed, currentBranch } from "../git.js"
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
		// branchAllowed, khong phai startsWith tu lam: neu hai cho tinh khac nhau thi
		// git_status bao "khong ghi duoc" trong khi edit_file van ghi duoc — kieu mau
		// thuan nay lam agent tuong minh bi chan roi di lam duong khac.
		writable: repo.write && branchAllowed(repo, branch),
		exit_code: r.code,
		dirty: r.stdout.split("\n").some((l) => l.trim() && !l.startsWith("##")),
		status: r.stdout.slice(0, 40_000),
	}
}

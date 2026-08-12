import { z } from "zod"
import { run } from "../exec.js"
import { assertGitRepo, branchAllowed } from "../git.js"
import { resolveRepo } from "../repos.js"

export const gitStatusSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
}

/** Ten branch tu dong header "## " cua `git status --porcelain=v1 --branch`. */
function branchFromStatusHeader(stdout: string): string {
	const first = stdout.split("\n", 1)[0] ?? ""
	if (!first.startsWith("## ")) return ""
	const b = first.slice(3).trim()
	if (b.startsWith("No commits yet on ")) return b.slice("No commits yet on ".length).trim()
	if (b === "HEAD (no branch)") return "" // detached HEAD
	const dots = b.indexOf("...") // "main...origin/main [ahead 1]"
	return (dots >= 0 ? b.slice(0, dots) : b).trim()
}

export async function gitStatus(a: { repo?: string }) {
	const repo = resolveRepo(a.repo)
	assertGitRepo(repo)
	const r = await run(["git", "status", "--porcelain=v1", "--branch"], {
		cwd: repo.root,
		timeoutMs: 30_000,
	})
	// Branch parse tu chinh output status: 1 luong duy nhat, va branch luon nhat
	// quan voi tree trong cung response. Truoc day goi them currentBranch — tuy da
	// co fast path doc .git/HEAD, van la mot duong doc lap co the lech voi status.
	const branch = branchFromStatusHeader(r.stdout)
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

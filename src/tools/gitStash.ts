import { z } from "zod"
import { run } from "../exec.js"
import { assertGitRepo, assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"

export const gitStashSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	action: z.enum(["push", "pop", "list"]).default("list").describe("Hanh dong stash: push (luu tam), pop (khoi phuc), list (xem danh sach)"),
	message: z.string().optional().describe("Ghi chu cho stash (khi action=push)"),
}

export async function gitStash(a: { repo?: string; action: "push" | "pop" | "list"; message?: string }) {
	const repo = resolveRepo(a.repo)
	assertGitRepo(repo)

	if (a.action === "push") {
		await assertWritableBranch(repo)
		const argv = a.message ? ["git", "stash", "push", "-m", a.message] : ["git", "stash", "push"]
		const r = await run(argv, { cwd: repo.root, timeoutMs: 30_000 })
		if (r.code !== 0) {
			throw new Error(`git stash push that bai (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
		}
		return {
			repo: repo.name,
			action: "push",
			output: r.stdout.trim() || r.stderr.trim(),
		}
	}

	if (a.action === "pop") {
		await assertWritableBranch(repo)
		const r = await run(["git", "stash", "pop"], { cwd: repo.root, timeoutMs: 30_000 })
		if (r.code !== 0) {
			throw new Error(`git stash pop that bai (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
		}
		return {
			repo: repo.name,
			action: "pop",
			output: r.stdout.trim() || r.stderr.trim(),
		}
	}

	// list
	const r = await run(["git", "stash", "list"], { cwd: repo.root, timeoutMs: 15_000 })
	const stashes = r.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)

	return {
		repo: repo.name,
		action: "list",
		stashes,
	}
}

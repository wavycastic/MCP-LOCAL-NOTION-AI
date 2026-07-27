import { z } from "zod"
import { run } from "../exec.js"
import { branchAllowed, currentBranch } from "../git.js"
import { assertWritableRepo, resolveRepo } from "../repos.js"

export const gitBranchSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	name: z.string().optional().describe("Ten branch de tao hoac chuyen sang. Bo trong de liet ke cac branch"),
	create: z.boolean().optional().describe("true: tao branch MOI (`git checkout -b <name>`). Mac dinh false: chuyen sang branch da ton tai"),
}

export async function gitBranch(a: { repo?: string; name?: string; create?: boolean }) {
	const repo = resolveRepo(a.repo)
	const cur = await currentBranch(repo)

	// Neu khong truyen name, liet ke cac branch
	if (!a.name) {
		const r = await run(["git", "branch", "-a"], { cwd: repo.root, timeoutMs: 15_000 })
		const branches = r.stdout
			.split("\n")
			.map((l) => l.trim().replace(/^\*\s*/, ""))
			.filter(Boolean)
		return {
			repo: repo.name,
			current_branch: cur,
			branches,
		}
	}

	const targetName = a.name.trim()
	if (!targetName) throw new Error("Ten branch khong duoc de trong")

	if (a.create) {
		assertWritableRepo(repo)
		if (!branchAllowed(repo, targetName)) {
			throw new Error(
				`ten branch MOI "${targetName}" khong phu hop voi branchPrefix "${repo.branchPrefix}" cua repo "${repo.name}"`,
			)
		}
		const r = await run(["git", "checkout", "-b", targetName], { cwd: repo.root, timeoutMs: 15_000 })
		if (r.code !== 0) {
			throw new Error(`git checkout -b that bai (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
		}
		return {
			repo: repo.name,
			created: true,
			branch: targetName,
			output: r.stdout.trim() || r.stderr.trim(),
		}
	}

	// Switch to existing branch
	const r = await run(["git", "checkout", targetName], { cwd: repo.root, timeoutMs: 15_000 })
	if (r.code !== 0) {
		throw new Error(`git checkout that bai (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
	}
	return {
		repo: repo.name,
		switched: true,
		branch: targetName,
		output: r.stdout.trim() || r.stderr.trim(),
	}
}

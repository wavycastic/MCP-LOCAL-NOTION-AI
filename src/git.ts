import { run } from "./exec.js"
import { assertWritableRepo, type Repo } from "./repos.js"

export async function currentBranch(repo: Repo): Promise<string> {
	const r = await run(["git", "branch", "--show-current"], {
		cwd: repo.root,
		timeoutMs: 15_000,
	})
	return r.stdout.trim()
}

/**
 * Goi o DAU moi tool co ghi. Hai cua:
 *   1. repo phai duoc cap quyen ghi trong repos.json
 *   2. branch hien tai phai khop branchPrefix cua repo do
 */
export async function assertWritableBranch(repo: Repo): Promise<string> {
	assertWritableRepo(repo)
	const b = await currentBranch(repo)
	if (!b.startsWith(repo.branchPrefix)) {
		throw new Error(
			`refusing to write in "${repo.name}" on branch "${b}" — chuyen sang branch "${repo.branchPrefix}*" truoc`,
		)
	}
	return b
}

export async function isDirty(repo: Repo): Promise<boolean> {
	const r = await run(["git", "status", "--porcelain"], {
		cwd: repo.root,
		timeoutMs: 15_000,
	})
	return r.stdout.trim().length > 0
}

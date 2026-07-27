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
 * branchPrefix = "*" (hoac de trong) nghia la KHONG gioi han branch: ghi duoc ca
 * tren main/master lan branch phu.
 *
 * De o day mot cho duy nhat, vi git_status cung phai tra ve dung "writable" —
 * truoc day no tu lam startsWith rieng, nen neu chi sua ham duoi thi git_status
 * se bao khong ghi duoc trong khi edit_file van ghi binh thuong.
 */
export function branchAllowed(repo: Repo, branch: string): boolean {
	const p = repo.branchPrefix.trim()
	if (p === "" || p === "*") return true
	return branch.startsWith(p)
}

/**
 * Goi o DAU moi tool co ghi. Hai cua:
 *   1. repo phai duoc cap quyen ghi trong repos.json
 *   2. branch hien tai phai khop branchPrefix cua repo do (tru khi prefix la "*")
 */
export async function assertWritableBranch(repo: Repo): Promise<string> {
	assertWritableRepo(repo)
	const b = await currentBranch(repo)
	if (!branchAllowed(repo, b)) {
		throw new Error(
			`refusing to write in "${repo.name}" on branch "${b}" — chuyen sang branch "${repo.branchPrefix}*" truoc, ` +
				`hoac dat "branchPrefix": "*" cho repo nay trong repos.json de cho ghi tren moi branch`,
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

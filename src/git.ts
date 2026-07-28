import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { run } from "./exec.js"
import { assertWritableRepo, type Repo } from "./repos.js"
import { FULL_ACCESS_ROOT } from "./security/paths.js"

export function assertGitRepo(repo: Repo): void {
	const cwd =
		repo.root === FULL_ACCESS_ROOT
			? (process.env.FULL_ACCESS_CWD ?? process.cwd())
			: repo.root
	if (!existsSync(join(cwd, ".git"))) {
		throw new Error(
			`Repo "${repo.name}" (cwd: "${cwd}") khong phai la mot Git Repository (khong tim thay thu muc .git). ` +
				`Vui long truyen tham so "repo" la mot Git repo cu the (vd: "CV-AUT", "local-repo-mcp", "flowlens") de thao tac Git.`,
		)
	}
}

export async function currentBranch(repo: Repo): Promise<string> {
	assertGitRepo(repo)
	const cwd =
		repo.root === FULL_ACCESS_ROOT
			? (process.env.FULL_ACCESS_CWD ?? process.cwd())
			: repo.root

	// Fast path: avoid spawning Git on every edit. Supports normal repos and
	// linked worktrees where .git is a `gitdir: ...` pointer file.
	try {
		const gitEntry = join(cwd, ".git")
		let gitDir = gitEntry
		if (!statSync(gitEntry).isDirectory()) {
			const pointer = readFileSync(gitEntry, "utf8").trim()
			if (!pointer.startsWith("gitdir:")) throw new Error("invalid .git pointer")
			const target = pointer.slice("gitdir:".length).trim()
			gitDir = isAbsolute(target) ? target : resolve(dirname(gitEntry), target)
		}
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim()
		const prefix = "ref: refs/heads/"
		return head.startsWith(prefix) ? head.slice(prefix.length) : ""
	} catch {
		const r = await run(["git", "branch", "--show-current"], {
			cwd,
			timeoutMs: 15_000,
		})
		return r.stdout.trim()
	}
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
	if (repo.source === "system") return true
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
	assertGitRepo(repo)
	if (repo.source === "system") return "(system)"
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
	assertGitRepo(repo)
	const r = await run(["git", "status", "--porcelain"], {
		cwd: repo.root,
		timeoutMs: 15_000,
	})
	return r.stdout.trim().length > 0
}

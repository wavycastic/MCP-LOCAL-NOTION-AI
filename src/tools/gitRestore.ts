import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"
import { safeResolveNew } from "../security/paths.js"
import { forgetTouched } from "../touched.js"

export const gitRestoreSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	paths: z
		.array(z.string())
		.min(1)
		.max(50)
		.describe("Danh sach file cu the can tra ve trang thai da commit. KHONG nhan \".\" hay wildcard"),
}

/** Chan moi thu co the bien lenh nay thanh "xoa sach thay doi". */
const FORBIDDEN = new Set([".", "./", "*", "", "/", ".."])

/**
 * Duong lui duy nhat: tra tung FILE ve dung trang thai o HEAD.
 *
 * Co y khong phai `git reset --hard` va khong phai `git checkout -- .`: hai lenh
 * do xoa sach ca thay doi cua nguoi dung. Day la path-scoped, chi tren repo co
 * quyen ghi va dang o branch agent/*, va chi voi file DA TRACK.
 */
export async function gitRestore(a: { repo?: string; paths: string[] }) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)

	for (const p of a.paths) {
		const t = p.trim()
		if (FORBIDDEN.has(t) || t.includes("*"))
			throw new Error(
				`"${p}" khong hop le: git_restore chi nhan duong dan file cu the, khong nhan "." hay wildcard`,
			)
		safeResolveNew(repo.root, t) // chroot + deny-list (file co the dang bi xoa)
	}

	// File chua track thi khong co gi de "tra ve" — bao ro thay vi de git bao kho hieu.
	const tracked = await run(["git", "ls-files", "--error-unmatch", "--", ...a.paths], {
		cwd: repo.root,
		timeoutMs: 30_000,
	})
	if (tracked.code !== 0)
		throw new Error(
			`co file chua track trong danh sach (khong co ban da commit de tra ve): ${
				tracked.stderr.trim() || tracked.stdout.trim()
			}. File moi tao thi dung remove_file`,
		)

	const r = await run(["git", "checkout", "HEAD", "--", ...a.paths], {
		cwd: repo.root,
		timeoutMs: 60_000,
	})
	if (r.code !== 0)
		throw new Error(`git checkout that bai: ${r.stderr.trim() || r.stdout.trim()}`)

	// Da hoan tac thi khong con la thay doi cho commit nua.
	forgetTouched(repo.root, ...a.paths)

	return {
		repo: repo.name,
		branch,
		restored: a.paths,
		exit_code: r.code,
	}
}

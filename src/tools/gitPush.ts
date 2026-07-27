import { z } from "zod"
import { ALLOW_PUSH, GIT_REMOTE } from "../config.js"
import { run } from "../exec.js"
import { assertWritableBranch, isDirty } from "../git.js"
import { resolveRepo } from "../repos.js"
import { peekTouched } from "../touched.js"

export const gitPushSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
}

/**
 * Push branch agent/* len remote. Khong bao gio --force, khong bao gio push nhanh khac.
 * Tat mac dinh: dat ALLOW_PUSH=true trong .env de bat.
 *
 * Dieu kien chan: chi chan khi CHINH PHAN AGENT SUA con chua commit (peekTouched),
 * khong chan vi working tree "dirty" chung chung.
 *
 * Ly do: `git status --porcelain` gom ca file untracked va submodule cua nguoi dung.
 * Mot repo thuc te luon co san vai thu nhu vay (anh chup man hinh o root, submodule
 * dang sua do) — dieu kien cu lam git_push khong bao gio chay duoc, du agent da
 * commit sach phan cua no. Va no di nguoc chinh triet ly cua git_commit: chi quan
 * tam den file agent cham.
 */
export async function gitPush(a: { repo?: string }) {
	if (!ALLOW_PUSH)
		throw new Error("push dang bi tat. Dat ALLOW_PUSH=true trong .env neu muon bat")

	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)

	const pending = peekTouched(repo.root)
	if (pending.length > 0)
		throw new Error(
			`con ${pending.length} file da sua nhung chua commit — goi git_commit truoc: ${pending
				.slice(0, 20)
				.join(", ")}`,
		)

	// Con dirty vi thu khac (untracked, submodule, nguoi dung tu sua): van push duoc,
	// nhung noi ro trong ket qua de agent bao lai cho nguoi dung.
	const dirtyOther = await isDirty(repo)

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
		...(dirtyOther
			? {
					note: "working tree con thay doi khong thuoc agent (untracked hoac submodule) — khong duoc push",
				}
			: {}),
		output: (r.stdout + r.stderr).slice(-8_000),
	}
}

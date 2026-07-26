import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"
import { safeResolve, safeResolveNew } from "../security/paths.js"
import { noteTouched } from "../touched.js"

export const moveFileSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	from: z.string().describe("Path nguon (phai ton tai, tuong doi repo root)"),
	to: z.string().describe("Path dich (chua ton tai, tuong doi repo root)"),
}

/** git mv de git nhan ra rename, giu duoc history/blame. Khong di chuyen cheo repo. */
export async function moveFile(a: { repo?: string; from: string; to: string }) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	safeResolve(repo.root, a.from)
	const absTo = safeResolveNew(repo.root, a.to)
	if (existsSync(absTo)) throw new Error(`${a.to} da ton tai`)

	mkdirSync(dirname(absTo), { recursive: true })
	const r = await run(["git", "mv", "--", a.from, a.to], {
		cwd: repo.root,
		timeoutMs: 60_000,
	})
	if (r.code !== 0)
		throw new Error(`git mv that bai: ${r.stderr.trim() || r.stdout.trim()}`)
	noteTouched(repo.root, a.from, a.to) // ca hai dau: xoa cho cu, them cho moi
	return { repo: repo.name, branch, from: a.from, to: a.to, exit_code: r.code }
}

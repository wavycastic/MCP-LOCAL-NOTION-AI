import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"
import { safeResolve } from "../security/paths.js"

export const removeFileSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	path: z.string().describe("File can xoa (tuong doi repo root)"),
	recursive: z.boolean().optional().describe("true khi xoa thu muc (git rm -r)"),
}

/** git rm — chi xoa thu da track. File chua track thi bao loi, khong tu xoa bua. */
export async function removeFile(a: {
	repo?: string
	path: string
	recursive?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	safeResolve(repo.root, a.path)
	const argv = ["git", "rm"]
	if (a.recursive) argv.push("-r")
	argv.push("--", a.path)
	const r = await run(argv, { cwd: repo.root, timeoutMs: 60_000 })
	if (r.code !== 0)
		throw new Error(`git rm that bai: ${r.stderr.trim() || r.stdout.trim()}`)
	return {
		repo: repo.name,
		branch,
		path: a.path,
		exit_code: r.code,
		output: r.stdout.slice(0, 8_000),
	}
}

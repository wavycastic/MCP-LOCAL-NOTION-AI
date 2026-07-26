import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { safeResolve } from "../security/paths.js"

export const removeFileSchema = {
	path: z.string().describe("File can xoa (tuong doi repo root)"),
	recursive: z.boolean().optional().describe("true khi xoa thu muc (git rm -r)"),
}

/** git rm — chi xoa thu da track. File chua track thi bao loi, khong tu xoa bua. */
export async function removeFile(a: { path: string; recursive?: boolean }) {
	await assertWritableBranch()
	safeResolve(a.path)
	const argv = ["git", "rm"]
	if (a.recursive) argv.push("-r")
	argv.push("--", a.path)
	const r = await run(argv, { timeoutMs: 60_000 })
	if (r.code !== 0) throw new Error(`git rm that bai: ${r.stderr.trim() || r.stdout.trim()}`)
	return { path: a.path, exit_code: r.code, output: r.stdout.slice(0, 8_000) }
}

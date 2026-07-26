import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { safeResolve, safeResolveNew } from "../security/paths.js"

export const moveFileSchema = {
	from: z.string().describe("Path nguon (phai ton tai, tuong doi repo root)"),
	to: z.string().describe("Path dich (chua ton tai, tuong doi repo root)"),
}

/** git mv de git nhan ra rename, giu duoc history/blame. */
export async function moveFile(a: { from: string; to: string }) {
	await assertWritableBranch()
	safeResolve(a.from)
	const absTo = safeResolveNew(a.to)
	if (existsSync(absTo)) throw new Error(`${a.to} da ton tai`)

	mkdirSync(dirname(absTo), { recursive: true })
	const r = await run(["git", "mv", "--", a.from, a.to], { timeoutMs: 60_000 })
	if (r.code !== 0) throw new Error(`git mv that bai: ${r.stderr.trim() || r.stdout.trim()}`)
	return { from: a.from, to: a.to, exit_code: r.code }
}

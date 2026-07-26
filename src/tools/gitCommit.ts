import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"

export const gitCommitSchema = {
	message: z.string().min(3).max(2000),
}

export async function gitCommit(a: { message: string }) {
	const branch = await assertWritableBranch()
	await run(["git", "add", "-A"], { timeoutMs: 60_000 })
	// spawn khong qua shell nen truyen -m truc tiep la an toan.
	const r = await run(["git", "commit", "-m", a.message], { timeoutMs: 60_000 })
	const sha = await run(["git", "rev-parse", "--short", "HEAD"], {
		timeoutMs: 15_000,
	})
	return {
		branch,
		sha: sha.stdout.trim(),
		exit_code: r.code,
		output: r.stdout + r.stderr,
	}
}

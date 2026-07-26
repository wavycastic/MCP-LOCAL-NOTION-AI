import { run } from "../exec.js"
import { currentBranch } from "../git.js"

export async function gitStatus() {
	const branch = await currentBranch()
	const r = await run(["git", "status", "--porcelain=v1", "--branch"], {
		timeoutMs: 30_000,
	})
	return {
		branch,
		exit_code: r.code,
		dirty: r.stdout.split("\n").some((l) => l.trim() && !l.startsWith("##")),
		status: r.stdout.slice(0, 40_000),
	}
}

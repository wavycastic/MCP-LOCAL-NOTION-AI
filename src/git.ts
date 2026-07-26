import { BRANCH_PREFIX } from "./config.js"
import { run } from "./exec.js"

export async function currentBranch(): Promise<string> {
	const r = await run(["git", "branch", "--show-current"], { timeoutMs: 15_000 })
	return r.stdout.trim()
}

/** Goi o DAU moi tool co ghi. Chan agent sua main / branch refactor cua ban. */
export async function assertWritableBranch(): Promise<string> {
	const b = await currentBranch()
	if (!b.startsWith(BRANCH_PREFIX)) {
		throw new Error(
			`refusing to write on branch "${b}" — chuyen sang branch "${BRANCH_PREFIX}*" truoc`,
		)
	}
	return b
}

export async function isDirty(): Promise<boolean> {
	const r = await run(["git", "status", "--porcelain"], { timeoutMs: 15_000 })
	return r.stdout.trim().length > 0
}

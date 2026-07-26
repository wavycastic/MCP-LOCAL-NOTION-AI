import { run } from "../exec.js"

// Khong co `git reset --hard` o day. Chieu B: local la nguon su that.
export async function reindex() {
	const r = await run(["npx", "gitnexus", "analyze"], { timeoutMs: 1_800_000 })
	return {
		exit_code: r.code,
		timed_out: r.timedOut,
		output: r.stdout.slice(-20_000),
	}
}

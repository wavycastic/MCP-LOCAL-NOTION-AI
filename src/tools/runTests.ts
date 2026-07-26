import { z } from "zod"
import { BUILD_CMD, TEST_CMD } from "../config.js"
import { run } from "../exec.js"

// Chi nhan --filter, khong nhan argv tuy y.
export const runTestsSchema = {
	filter: z
		.string()
		.regex(/^[A-Za-z0-9_.~=|!&()\-]+$/, "filter chua ky tu khong cho phep")
		.optional(),
}

export async function runTests(a: { filter?: string }) {
	const argv = [...TEST_CMD]
	if (a.filter) argv.push("--filter", a.filter)
	const r = await run(argv)
	return {
		exit_code: r.code,
		timed_out: r.timedOut,
		output: (r.stdout + "\n" + r.stderr).slice(-60_000), // duoi log la cho co loi
	}
}

export async function runBuild() {
	const r = await run([...BUILD_CMD])
	return {
		exit_code: r.code,
		timed_out: r.timedOut,
		output: (r.stdout + "\n" + r.stderr).slice(-60_000),
	}
}

import { z } from "zod"
import { run } from "../exec.js"

export const ripgrepSchema = {
	pattern: z.string(),
	glob: z.string().optional().describe("vd: *.cs, *.axaml"),
	ignore_case: z.boolean().optional(),
	max_count: z.number().int().min(1).max(500).optional(),
}

export async function ripgrep(a: {
	pattern: string
	glob?: string
	ignore_case?: boolean
	max_count?: number
}) {
	const argv = ["rg", "--line-number", "--no-heading", "--color", "never"]
	if (a.ignore_case) argv.push("-i")
	if (a.glob) argv.push("--glob", a.glob)
	argv.push("--max-count", String(a.max_count ?? 100))
	argv.push("--regexp", a.pattern) // --regexp: pattern khong bi hieu thanh flag
	argv.push(".")
	const r = await run(argv, { timeoutMs: 60_000 })
	return { matches: r.stdout, exit_code: r.code }
}

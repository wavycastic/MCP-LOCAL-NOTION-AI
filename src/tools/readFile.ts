import { readFileSync } from "node:fs"
import { z } from "zod"
import { safeResolve } from "../security/paths.js"

export const readFileSchema = {
	path: z.string(),
	line_start: z.number().int().min(1).optional(),
	line_end: z.number().int().min(1).optional(),
}

export async function readFile(a: {
	path: string
	line_start?: number
	line_end?: number
}) {
	const abs = safeResolve(a.path)
	const lines = readFileSync(abs, "utf8").split("\n")
	const start = (a.line_start ?? 1) - 1
	const end = Math.min(a.line_end ?? start + 400, lines.length) // luon phan trang
	return {
		path: a.path,
		start_line: start + 1,
		end_line: end,
		total_lines: lines.length,
		truncated: end < lines.length,
		text: lines.slice(start, end).join("\n"),
	}
}

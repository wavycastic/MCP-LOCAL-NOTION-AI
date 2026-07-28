import { statSync } from "node:fs"
import { z } from "zod"
import { MAX_READ_BYTES } from "../config.js"
import { readTextSnapshot } from "../files/text.js"
import { resolveRepo } from "../repos.js"
import { safeResolve } from "../security/paths.js"

export const readFileSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	path: z.string(),
	line_start: z.number().int().min(1).optional(),
	line_end: z.number().int().min(1).optional(),
}

export async function readFile(a: {
	repo?: string
	path: string
	line_start?: number
	line_end?: number
}) {
	const repo = resolveRepo(a.repo)
	const abs = safeResolve(repo.root, a.path)

	const size = statSync(abs).size
	if (size > MAX_READ_BYTES) {
		throw new Error(
			`${a.path} nang ${size} bytes, vuot MAX_READ_BYTES=${MAX_READ_BYTES}. ` +
				`Dung ripgrep de tim doan can xem thay vi doc ca file`,
		)
	}

	const snap = readTextSnapshot(abs)
	const lines = snap.text.split("\n")
	const start = (a.line_start ?? 1) - 1
	const end = Math.min(a.line_end ?? start + 400, lines.length)

	return {
		repo: repo.name,
		path: a.path,
		start_line: start + 1,
		end_line: end,
		total_lines: lines.length,
		truncated: end < lines.length,
		text: lines.slice(start, end).join("\n"),
		size_bytes: snap.sizeBytes,
		sha256: snap.sha256,
		eol: snap.eol,
		bom: snap.bom,
	}
}

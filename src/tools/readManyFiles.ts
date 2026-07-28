import { stat } from "node:fs/promises"
import { z } from "zod"
import { MAX_READ_BYTES } from "../config.js"
import { mapLimit } from "../files/concurrency.js"
import { readTextSnapshotAsync } from "../files/text.js"
import { resolveRepo } from "../repos.js"
import { isDeniedRelPath, safeResolve } from "../security/paths.js"

export const readManyFilesSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	files: z
		.array(
			z.object({
				path: z.string().describe("Duong dan tuong doi so voi repo root"),
				line_start: z.number().int().min(1).optional(),
				line_end: z.number().int().min(1).optional(),
			}),
		)
		.min(1)
		.max(50)
		.describe("Danh sach cac file can doc (1-50 files)"),
	max_total_bytes: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Tong gioi han byte cho toan bo request (mac dinh: MAX_READ_BYTES)"),
}

type FileItemResult = {
	path: string
	ok: boolean
	error?: string
	start_line?: number
	end_line?: number
	total_lines?: number
	truncated?: boolean
	text?: string
	size_bytes?: number
	sha256?: string
	eol?: "lf" | "crlf"
	bom?: boolean
}

export async function readManyFiles(a: {
	repo?: string
	files: Array<{ path: string; line_start?: number; line_end?: number }>
	max_total_bytes?: number
}) {
	const repo = resolveRepo(a.repo)
	const maxTotalBytes = a.max_total_bytes ?? MAX_READ_BYTES

	type Prepared = { result: FileItemResult; sliceBytes: number }
	const prepared = await mapLimit(a.files, 8, async (item): Promise<Prepared> => {
		try {
			if (isDeniedRelPath(item.path)) {
				return { result: { path: item.path, ok: false, error: `Path nam trong deny-list: '${item.path}'` }, sliceBytes: 0 }
			}
			const abs = safeResolve(repo.root, item.path)
			const size = (await stat(abs)).size
			if (size > MAX_READ_BYTES) {
				return { result: { path: item.path, ok: false, error: `${item.path} nang ${size} bytes, vuot MAX_READ_BYTES=${MAX_READ_BYTES}` }, sliceBytes: 0 }
			}

			const snap = await readTextSnapshotAsync(abs)
			const lines = snap.text.split("\n")
			const start = (item.line_start ?? 1) - 1
			const end = Math.min(item.line_end ?? start + 400, lines.length)
			const sliceText = lines.slice(start, end).join("\n")
			const sliceBytes = Buffer.byteLength(sliceText, "utf8")
			return {
				result: {
					path: item.path,
					ok: true,
					start_line: start + 1,
					end_line: end,
					total_lines: lines.length,
					truncated: end < lines.length,
					text: sliceText,
					size_bytes: snap.sizeBytes,
					sha256: snap.sha256,
					eol: snap.eol,
					bom: snap.bom,
				},
				sliceBytes,
			}
		} catch (err: any) {
			return { result: { path: item.path, ok: false, error: err.message ?? String(err) }, sliceBytes: 0 }
		}
	})

	let accumulatedBytes = 0
	let truncated = false
	const results: FileItemResult[] = []
	for (const item of prepared) {
		if (item.result.ok && accumulatedBytes + item.sliceBytes > maxTotalBytes) {
			truncated = true
			results.push({ path: item.result.path, ok: false, error: `Vuot max_total_bytes=${maxTotalBytes}` })
			continue
		}
		if (item.result.ok) accumulatedBytes += item.sliceBytes
		results.push(item.result)
	}

	return {
		repo: repo.name,
		files: results,
		total_bytes: accumulatedBytes,
		truncated,
	}
}

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { resolveRepo } from "../repos.js"
import { safeResolveDir } from "../security/paths.js"

const SKIP = new Set([
	".git",
	"node_modules",
	"bin",
	"obj",
	"dist",
	"target",
	".venv",
	"__pycache__",
])

export const listDirSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	path: z.string().optional().describe("Duong dan tuong doi so voi repo root. Mac dinh la root"),
	max_entries: z.number().int().min(1).max(1000).optional(),
}

export async function listDir(a: {
	repo?: string
	path?: string
	max_entries?: number
}) {
	const repo = resolveRepo(a.repo)
	const abs = safeResolveDir(repo.root, a.path)
	const limit = a.max_entries ?? 300
	const raw = readdirSync(abs, { withFileTypes: true })

	// Tach 2 buoc: "bi skip" khac "bi cat vi qua limit". Truoc day total = raw.length
	// nen thu muc chua bin/obj luon bao truncated:true du da tra du entry -> agent
	// tuong con file an va di doc lai vo ich.
	const kept = raw.filter((e) => !SKIP.has(e.name))

	const entries = kept
		.slice(0, limit)
		.map((e) => {
			const isDir = e.isDirectory()
			let size: number | null = null
			if (!isDir) {
				try {
					size = statSync(join(abs, e.name)).size
				} catch {}
			}
			return { name: e.name, type: isDir ? "dir" : "file", size }
		})
		.sort((x, y) =>
			x.type === y.type ? x.name.localeCompare(y.name) : x.type === "dir" ? -1 : 1,
		)

	return {
		repo: repo.name,
		path: a.path ?? ".",
		/** So entry sau khi bo cac thu muc trong SKIP. */
		total: kept.length,
		/** Chi true khi that su con entry chua tra vi vuot max_entries. */
		truncated: kept.length > entries.length,
		skipped_dirs: raw.length - kept.length,
		skipped: [...SKIP],
		entries,
	}
}

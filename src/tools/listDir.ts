import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { safeResolveDir } from "../security/paths.js"

const SKIP = new Set([".git", "node_modules", "bin", "obj", "dist"])

export const listDirSchema = {
	path: z.string().optional().describe("Duong dan tuong doi so voi repo root. Mac dinh la root"),
	max_entries: z.number().int().min(1).max(1000).optional(),
}

export async function listDir(a: { path?: string; max_entries?: number }) {
	const abs = safeResolveDir(a.path)
	const limit = a.max_entries ?? 300
	const raw = readdirSync(abs, { withFileTypes: true })

	const entries = raw
		.filter((e) => !SKIP.has(e.name))
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
		.sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === "dir" ? -1 : 1))

	return {
		path: a.path ?? ".",
		total: raw.length,
		truncated: raw.length > entries.length,
		skipped: [...SKIP],
		entries,
	}
}

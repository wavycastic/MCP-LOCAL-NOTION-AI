import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { run } from "../exec.js"
import { resolveRepo } from "../repos.js"
import { safeResolveDir } from "../security/paths.js"

/**
 * Thu muc rac quen mat, chan san khong can hoi git. Van giu day du .gitignore
 * khong liet ke chung (vd .git), va de khong phai goi git chi de biet node_modules
 * la rac.
 */
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
	include_ignored: z
		.boolean()
		.optional()
		.describe(
			"Mac dinh false: bo qua thu bi .gitignore loai. Dat true khi can xem chinh thu muc output (publish/, captures/...)",
		),
}

/**
 * Ten cac entry ngay trong thu muc nay ma git coi la bi ignore.
 *
 * Khong dung `git check-ignore` vi no nhan danh sach qua stdin, ma exec.ts co y
 * khong mo stdin. `ls-files --others --ignored` chay trong dung thu muc do va in
 * duong dan tuong doi, thu muc thi co dau / o cuoi.
 *
 * Loi (chua cai git, thu muc khong thuoc repo git) khong duoc lam sap list_dir:
 * cung lam thi chi la liet ke nhieu hon can thiet.
 */
async function ignoredNames(cwd: string): Promise<Set<string> | null> {
	try {
		const r = await run(
			[
				"git",
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
				"--directory",
				"--no-empty-directory",
				"--",
				".",
			],
			{ cwd, timeoutMs: 20_000 },
		)
		if (r.code !== 0) return null
		const names = new Set<string>()
		for (const line of r.stdout.split("\n")) {
			const p = line.trim().replace(/\/$/, "")
			if (!p) continue
			// Chi quan tam entry cap 1: "publish/net8.0/app.dll" -> "publish"
			const first = p.split("/")[0]
			if (first) names.add(first)
		}
		return names
	} catch {
		return null
	}
}

export async function listDir(a: {
	repo?: string
	path?: string
	max_entries?: number
	include_ignored?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const abs = safeResolveDir(repo.root, a.path)
	const limit = a.max_entries ?? 300
	const raw = readdirSync(abs, { withFileTypes: true })

	/*
	 * Khong doc .gitignore thi list_dir loi thang vao publish/, captures/, .tmp-build/
	 * cua CV-AUT — hang nghin file build ra, khong co gia tri doc, va lan nao cung
	 * lam agent tuong do la code cua du an.
	 */
	const ignored = a.include_ignored ? null : await ignoredNames(abs)

	const kept = raw.filter((e) => !SKIP.has(e.name) && !(ignored?.has(e.name) ?? false))

	// Tach 2 buoc: "bi skip" khac "bi cat vi qua limit". Truoc day total = raw.length
	// nen thu muc chua bin/obj luon bao truncated:true du da tra du entry -> agent
	// tuong con file an va di doc lai vo ich.
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
		/** So entry sau khi bo thu muc trong SKIP va thu bi .gitignore loai. */
		total: kept.length,
		/** Chi true khi that su con entry chua tra vi vuot max_entries. */
		truncated: kept.length > entries.length,
		skipped_dirs: raw.length - kept.length,
		skipped: [...SKIP],
		gitignore_applied: ignored !== null,
		...(ignored && ignored.size > 0 ? { ignored_here: [...ignored].slice(0, 50) } : {}),
		entries,
	}
}

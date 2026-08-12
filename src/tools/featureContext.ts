import { stat } from "node:fs/promises"
import { z } from "zod"
import { MAX_READ_BYTES } from "../config.js"
import { run } from "../exec.js"
import { mapLimit } from "../files/concurrency.js"
import { readTextSnapshotAsync } from "../files/text.js"
import { resolveRepo } from "../repos.js"
import { isDeniedRelPath, safeResolve } from "../security/paths.js"
import { cacheGet, cacheInflight, cachePut, repoStamp, type Fingerprint } from "../contextCache.js"
import { getSymbolIndex } from "../symbolIndex.js"
import { DENY_GLOBS, DENY_PATHSPECS } from "./ripgrep.js"

export const featureContextSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	query: z
		.string()
		.min(1)
		.describe(
			"Chuoi/regex can tim (ten symbol/ham/chuoi loi); moi file match duoc doc va tra ve cung 1 response",
		),
	glob: z.string().optional().describe("Gioi han loai file, vd: *.cs, *.ts, *.axaml"),
	ignore_case: z.boolean().optional(),
	detail: z
		.enum(["L0", "L1", "L2"])
		.optional()
		.describe(
			"L0 = chi danh sach file; L1 (mac dinh) = outline + doan quanh match; L2 = nguyen file",
		),
	full_file: z
		.boolean()
		.optional()
		.describe("CU — dung detail. true=L2, false=L1"),
	context_lines: z
		.number()
		.int()
		.min(1)
		.max(300)
		.optional()
		.describe("So dong context moi ben cua match khi L1 (mac dinh 25)"),
	max_files: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe("So file toi da doc, theo so match giam dan (mac dinh 8)"),
	max_total_bytes: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Gioi han tong byte noi dung tra ve (mac dinh 100KB)"),
	refresh: z
		.boolean()
		.optional()
		.describe("Bo qua cache (git HEAD + fingerprint)"),
}

type Args = {
	repo?: string
	query: string
	glob?: string
	ignore_case?: boolean
	detail?: "L0" | "L1" | "L2"
	full_file?: boolean
	context_lines?: number
	max_files?: number
	max_total_bytes?: number
	refresh?: boolean
}

type Engine = "ripgrep" | "git-grep"

type FileEntry = {
	path: string
	match_count: number
	ok: boolean
	error?: string
	start_line?: number
	end_line?: number
	total_lines?: number
	truncated?: boolean
	text?: string
	outline?: string[]
	size_bytes?: number
}

type FeatureContextResult = {
	repo: string
	query: string
	engine: Engine
	/** true khi outline lay tu tree-sitter symbol index thay vi regex heuristic. */
	symbol_index: boolean
	matched_files: number
	files: FileEntry[]
	total_bytes: number
	truncated: boolean
	cache_hit: boolean
	elapsed_ms: number
	note?: string
}

/** Tran payload mac dinh tra ve: du nho de moi buoc suy luan LLM prefill nhanh (~25K tokens). */
const DEFAULT_TOTAL_BYTES = 100_000

// Cache dung chung voi trace_flow: key gan voi git HEAD, fingerprint (size+mtime)
// bat ca thay doi chua commit. Xem src/contextCache.ts.

function normalizeRel(p: string): string {
	let s = p.trim().replace(/\\/g, "/")
	if (s.startsWith("./")) s = s.slice(2)
	return s
}

/*
 * Mot tien trinh rg duy nhat (`rg --json`): vua dem match tung file vua lay
 * so dong match — truoc day can 2 process (`--count-matches` roi `--line-number`).
 * So match cong theo submatches de giu nguyen ngu nghia xep hang cua --count-matches.
 */
async function grepJson(
	root: string,
	a: Args,
): Promise<{ counts: Map<string, number>; lineMap: Map<string, number[]>; engine: Engine }> {
	const counts = new Map<string, number>()
	const lineMap = new Map<string, number[]>()

	const rg = ["rg", "--json", "--color", "never", "--max-count", "500"]
	if (a.ignore_case) rg.push("-i")
	if (a.glob) rg.push("--glob", a.glob)
	for (const g of DENY_GLOBS) rg.push("--glob", g)
	rg.push("--regexp", a.query, ".")

	try {
		// --json verbose hon nhieu nen nang tran output; van phai chan cat giua
		// chung vi JSON bi cat ngang se parse sai lech.
		const r = await run(rg, { cwd: root, timeoutMs: 60_000, maxOutputBytes: 8_000_000 })
		if (r.code === 2) throw new Error(`rg loi: ${r.stderr.slice(0, 300)}`)
		if (r.outputTruncated) {
			throw new Error("ket qua rg --json vuot 8MB — dat query cu the hon (glob/ten symbol)")
		}
		for (const line of r.stdout.split(/\r?\n/)) {
			if (line.charCodeAt(0) !== 123) continue // chi quan tam dong JSON
			let ev: any
			try {
				ev = JSON.parse(line)
			} catch {
				continue
			}
			if (ev?.type !== "match") continue
			const p = normalizeRel(String(ev.data?.path?.text ?? ""))
			if (!p) continue
			const subs = ev.data?.submatches
			const n = Array.isArray(subs) && subs.length > 0 ? subs.length : 1
			counts.set(p, (counts.get(p) ?? 0) + n)
			const ln = Number(ev.data?.line_number)
			if (Number.isInteger(ln) && ln >= 1) {
				const arr = lineMap.get(p)
				if (arr) {
					if (arr.length < 300) arr.push(ln)
				} else {
					lineMap.set(p, [ln])
				}
			}
		}
		return { counts, lineMap, engine: "ripgrep" }
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (!msg.includes("ENOENT")) throw e
		// Fallback git grep: 1 process -n; counts suy ra tu so dong match.
		const gg = ["git", "grep", "--line-number", "--no-color"]
		if (a.ignore_case) gg.push("-i")
		gg.push("-e", a.query, "--", ...(a.glob ? [a.glob] : []), ...DENY_PATHSPECS)
		const r = await run(gg, { cwd: root, timeoutMs: 60_000 })
		for (const line of r.stdout.split(/\r?\n/)) {
			const m = /^(.+?):(\d+):/.exec(line)
			if (!m) continue
			const p = normalizeRel(m[1])
			if (!p) continue
			counts.set(p, (counts.get(p) ?? 0) + 1)
			const ln = Number(m[2])
			const arr = lineMap.get(p)
			if (arr) arr.push(ln)
			else lineMap.set(p, [ln])
		}
		return { counts, lineMap, engine: "git-grep" }
	}
}

function mergeWindows(
	matchLines: number[],
	totalLines: number,
	ctx: number,
): Array<[number, number]> {
	const sorted = [...new Set(matchLines)].sort((x, y) => x - y)
	const out: Array<[number, number]> = []
	for (const ln of sorted) {
		const s = Math.max(1, ln - ctx)
		const e = Math.min(totalLines, ln + ctx)
		const last = out[out.length - 1]
		if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
		else out.push([s, e])
	}
	return out
}

const OUTLINE_CONTROL_RE =
	/^\s*(?:if|for|foreach|while|switch|catch|return|using|lock|do|else|try|finally|throw|new|typeof|sizeof|await|yield|case|break|continue|goto)\b/
const OUTLINE_RE = new RegExp(
	"^\\s{0,16}(?:(?:export|public|private|protected|internal|static|async|override|virtual|sealed|abstract|partial|readonly|final|open|suspend|inline|extern|const|let|var)\\s+)*(?:" +
		"(?:class|interface|struct|enum|record|namespace|object|trait|impl|module|type)\\s+[\\w.]+|" +
		"(?:[\\w<>\\[\\],.?*]+\\s+)*[~\\w]+\\s*\\([^;{}]*\\)\\s*(?:\\{|=>|:|where\\b|$))",
)
const OUTLINE_MAX = 40

/** Outline heuristic bang regex (khong phai LSP): class/method signature, toi da 40 dong/file. */
function extractOutline(lines: string[]): string[] {
	const out: string[] = []
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]
		if (l.length > 200 || OUTLINE_CONTROL_RE.test(l)) continue
		if (OUTLINE_RE.test(l)) out.push(`${i + 1}: ${l.trim()}`)
		if (out.length >= OUTLINE_MAX) break
	}
	return out
}

export async function featureContext(a: Args) {
	const t0 = Date.now()
	const repo = resolveRepo(a.repo)
	const detail: "L0" | "L1" | "L2" =
		a.detail ?? (a.full_file === true ? "L2" : a.full_file === false ? "L1" : "L1")
	const contextLines = a.context_lines ?? 25
	const maxFiles = a.max_files ?? 8
	const maxTotalBytes = a.max_total_bytes ?? DEFAULT_TOTAL_BYTES

	const head = await repoStamp(repo.root)
	const cacheKey = [
		repo.root,
		head,
		a.query,
		a.glob ?? "",
		String(!!a.ignore_case),
		detail,
		String(contextLines),
		String(maxFiles),
		String(maxTotalBytes),
	].join("\u0000")

	if (!a.refresh) {
		const hit = await cacheGet<FeatureContextResult>(cacheKey, repo.root)
		if (hit) return { ...hit, cache_hit: true, elapsed_ms: Date.now() - t0 }
	}

	// Dedup in-flight: 2 call giong nhau song song chi compute 1 lan.
	return cacheInflight(cacheKey, async () => {
	// Symbol index cho outline theo AST (chinh xac hon regex); null thi dung
	// heuristic cu. Dat SAU cache check: warm hit khong phai tra chi phi index.
	const symbolIndex = await getSymbolIndex(repo.root).catch(() => null)

	// 1. Mot tien trinh rg duy nhat (--json): vua dem match vua lay so dong.
	const { counts, lineMap, engine } = await grepJson(repo.root, a)
	const ranked = [...counts.entries()]
		.filter(([p]) => !isDeniedRelPath(p))
		.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))

	const matchedFiles = ranked.length
	const selected = ranked.slice(0, maxFiles)
	let truncated = matchedFiles > selected.length

	// 2. (Da gop vao buoc 1: lineMap co san tu rg --json, khong can process thu hai.)

	// 3. Doc song song (tran 8) qua cung duong text.ts/security nhu read_many_files.
	type Prepared = { entry: FileEntry; bytes: number; fp?: Fingerprint }
	const prepared = await mapLimit(selected, 8, async ([path, matchCount]): Promise<Prepared> => {
		const base: FileEntry = { path, match_count: matchCount, ok: false }
		try {
			const abs = safeResolve(repo.root, path)
			const st = await stat(abs)
			const fp: Fingerprint = { path, size: st.size, mtimeMs: st.mtimeMs }

			// L0: chi stat, khong doc noi dung — nhanh nhat, de agent danh gia pham vi truoc.
			if (detail === "L0") {
				return { entry: { ...base, ok: true, size_bytes: st.size }, bytes: 0, fp }
			}

			if (st.size > MAX_READ_BYTES) {
				return {
					entry: {
						...base,
						error:
							`${path} nang ${st.size} bytes, vuot MAX_READ_BYTES=${MAX_READ_BYTES}. ` +
							`Dung detail=L1 de chi lay outline va doan quanh match`,
					},
					bytes: 0,
					fp,
				}
			}

			const snap = await readTextSnapshotAsync(abs)
			const lines = snap.text.split("\n")
			let text: string
			let startLine = 1
			let endLine = lines.length
			let cut = false
			let outline: string[] | undefined
			if (detail === "L2") {
				text = snap.text
			} else {
				// Outline: uu tien AST tu symbol index; fallback regex heuristic.
				const indexed = symbolIndex?.byFile.get(path)
				outline =
					indexed && indexed.length > 0
						? indexed.slice(0, OUTLINE_MAX).map((d) => `${d.line}: ${d.kind} ${d.name}`)
						: extractOutline(lines)
				const wins = mergeWindows(lineMap.get(path) ?? [], lines.length, contextLines)
				if (wins.length === 0) {
					text = lines.slice(0, contextLines).join("\n")
				} else {
					text = wins.map(([s, e]) => lines.slice(s - 1, e).join("\n")).join("\n...\n")
					startLine = wins[0][0]
					endLine = wins[wins.length - 1][1]
				}
				cut = true
			}
			return {
				entry: {
					...base,
					ok: true,
					start_line: startLine,
					end_line: endLine,
					total_lines: lines.length,
					truncated: cut,
					text,
					...(outline ? { outline } : {}),
					size_bytes: snap.sizeBytes,
				},
				bytes: Buffer.byteLength(text, "utf8"),
				fp,
			}
		} catch (err: any) {
			return { entry: { ...base, error: err?.message ?? String(err) }, bytes: 0 }
		}
	})

	// 4. Ap budget tong: file nao vuot thi bao ro buoc tiep theo thay vi im lang cat.
	let totalBytes = 0
	const files: FileEntry[] = []
	const fingerprints: Fingerprint[] = []
	for (const p of prepared) {
		if (p.entry.ok && totalBytes + p.bytes > maxTotalBytes) {
			truncated = true
			files.push({
				path: p.entry.path,
				match_count: p.entry.match_count,
				ok: false,
				error: `Vuot max_total_bytes=${maxTotalBytes}. Goi lai voi query cu the hon hoac tang max_total_bytes`,
			})
			continue
		}
		if (p.entry.ok) {
			totalBytes += p.bytes
			if (p.fp) fingerprints.push(p.fp)
		}
		files.push(p.entry)
	}

	const notes: string[] = []
	if (engine === "git-grep")
		notes.push("chua cai ripgrep nen dung git grep: chi tim trong file da track")
	if (truncated)
		notes.push(
			"Da cat bot ket qua (max_files/max_total_bytes). Goi lai voi query cu the hon de lay phan con thieu",
		)

	const result: FeatureContextResult = {
		repo: repo.name,
		query: a.query,
		engine,
		symbol_index: symbolIndex !== null,
		matched_files: matchedFiles,
		files,
		total_bytes: totalBytes,
		truncated,
		cache_hit: false,
		elapsed_ms: Date.now() - t0,
		...(notes.length > 0 ? { note: notes.join(". ") } : {}),
	}

	// repoStamp da bat ca file moi chua commit (git status), nen ket qua rong cung
	// cache binh thuong — file moi xuat hien se doi stamp va tu miss.
	cachePut(cacheKey, fingerprints, result)
	return result
	})
}

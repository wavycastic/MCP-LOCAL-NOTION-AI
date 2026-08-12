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

export const traceFlowSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	symbol: z
		.string()
		.min(1)
		.max(120)
		.describe("Ten symbol can lan (chu/so/gach duoi/cham, vd: UpgradeWallAsync)"),
	glob: z.string().optional().describe("Gioi han loai file, vd: *.cs, *.ts"),
	depth: z
		.number()
		.int()
		.min(1)
		.max(2)
		.optional()
		.describe("1 = callers+callees truc tiep (mac dinh); 2 = lan them 1 tang (chi ten)"),
	def_body_lines: z
		.number()
		.int()
		.min(5)
		.max(120)
		.optional()
		.describe("So dong doc tu diem dinh nghia (mac dinh 80)"),
	max_files: z
		.number()
		.int()
		.min(1)
		.max(25)
		.optional()
		.describe("Tran so file dinh nghia duoc doc (mac dinh 10)"),
	refresh: z.boolean().optional().describe("Bo qua cache"),
}

type Args = {
	repo?: string
	symbol: string
	glob?: string
	depth?: number
	def_body_lines?: number
	max_files?: number
	refresh?: boolean
}

type Engine = "ripgrep" | "git-grep"
type Loc = { path: string; line: number }
type DefEntry = Loc & { snippet: string; body?: string; body_end_line?: number }

type TraceResult = {
	repo: string
	symbol: string
	engine: Engine
	/** true khi dinh nghia/callee lay tu tree-sitter symbol index thay vi regex heuristic. */
	symbol_index: boolean
	definitions: DefEntry[]
	callers: Array<Loc & { snippet: string }>
	callees: Array<{ name: string; definitions: Loc[]; callees?: string[] }>
	total_matches: number
	truncated: boolean
	cache_hit: boolean
	elapsed_ms: number
	note?: string
}

const SYMBOL_RE = /^[A-Za-z_][\w.]*$/
const LINE_RE = /^(.+?):(\d+):(.*)$/
const MAX_MATCHES = 500
const MAX_CALLERS = 50
const TOP_CALLEES = 5

/* Tu khoa dieu khien + builtin pho bien — loai khoi danh sach callees. */
const CONTROL_WORDS = new Set([
	"if", "for", "foreach", "while", "switch", "catch", "return", "using", "lock", "do",
	"else", "try", "finally", "throw", "new", "typeof", "sizeof", "await", "yield", "case",
	"break", "continue", "goto", "this", "base", "var", "let", "const", "function", "def",
	"class", "interface", "struct", "enum", "record", "namespace", "public", "private",
	"protected", "internal", "static", "async", "void", "int", "long", "float", "double",
	"bool", "string", "char", "true", "false", "null", "undefined", "import", "from",
	"export", "extends", "implements", "override", "virtual", "sealed", "abstract",
	"partial", "readonly", "get", "set", "init", "where", "select", "Console", "Math",
	"String", "Task", "List", "Dictionary", "DateTime", "Guid", "Exception",
])

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parseLine(l: string): { path: string; line: number; text: string } | null {
	const m = LINE_RE.exec(l)
	if (!m) return null
	let p = m[1].trim().replace(/\\/g, "/")
	if (p.startsWith("./")) p = p.slice(2)
	return { path: p, line: Number(m[2]), text: m[3] }
}

/** rg -n, lui ve git grep khi chua cai ripgrep (chi tim file da track). */
async function grepLines(
	root: string,
	pattern: string,
	glob: string | undefined,
	maxCount: number,
): Promise<{ lines: string[]; engine: Engine }> {
	const rg = ["rg", "--line-number", "--no-heading", "--color", "never"]
	if (glob) rg.push("--glob", glob)
	for (const g of DENY_GLOBS) rg.push("--glob", g)
	rg.push("--max-count", String(maxCount), "--regexp", pattern, ".")
	try {
		const r = await run(rg, { cwd: root, timeoutMs: 60_000 })
		if (r.code === 2) throw new Error(`rg loi: ${r.stderr.slice(0, 300)}`)
		return { lines: r.stdout.split(/\r?\n/).filter(Boolean), engine: "ripgrep" }
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (!msg.includes("ENOENT")) throw e
		const gg = ["git", "grep", "--line-number", "--no-color", "-e", pattern, "--", ...(glob ? [glob] : []), ...DENY_PATHSPECS]
		const r = await run(gg, { cwd: root, timeoutMs: 60_000 })
		return { lines: r.stdout.split(/\r?\n/).filter(Boolean), engine: "git-grep" }
	}
}

/** Trich ten cac ham duoc goi trong 1 khoi code (heuristic, bo qua keyword/builtin). */
function extractCalls(body: string, skip: Set<string>, into: Map<string, number>): void {
	for (const cm of body.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
		const n = cm[1]
		if (CONTROL_WORDS.has(n) || skip.has(n)) continue
		into.set(n, (into.get(n) ?? 0) + 1)
	}
}

async function readBodyWindow(
	root: string,
	loc: Loc,
	bodyLines: number,
	fingerprints: Fingerprint[],
): Promise<string | null> {
	try {
		const abs = safeResolve(root, loc.path)
		const st = await stat(abs)
		if (st.size > MAX_READ_BYTES) return null
		const snap = await readTextSnapshotAsync(abs)
		fingerprints.push({ path: loc.path, size: st.size, mtimeMs: st.mtimeMs })
		const arr = snap.text.split("\n")
		const start = Math.max(0, loc.line - 2)
		const end = Math.min(arr.length, loc.line + bodyLines)
		return arr.slice(start, end).join("\n")
	} catch {
		return null
	}
}

export async function traceFlow(a: Args) {
	const t0 = Date.now()
	const repo = resolveRepo(a.repo)
	const sym = a.symbol.trim()
	if (!SYMBOL_RE.test(sym))
		throw new Error(
			`symbol "${a.symbol}" khong hop le — chi chap nhan chu/so/gach duoi/cham (vd: UpgradeWallAsync, WallUpdater.Scan)`,
		)
	const depth = a.depth ?? 1
	const bodyLines = a.def_body_lines ?? 80
	const maxFiles = a.max_files ?? 10

	const head = await repoStamp(repo.root)
	const cacheKey = ["trace", repo.root, head, sym, a.glob ?? "", String(depth), String(bodyLines), String(maxFiles)].join("\u0000")
	if (!a.refresh) {
		const hit = await cacheGet<TraceResult>(cacheKey, repo.root)
		if (hit) return { ...hit, cache_hit: true, elapsed_ms: Date.now() - t0 }
	}

	// Dedup in-flight: 2 call giong nhau song song chi compute 1 lan.
	return cacheInflight(cacheKey, async () => {
	// Symbol index (tree-sitter): definition/callee chinh xac theo AST, lookup O(1).
	// Loi bat ky -> null, lui ve duong regex heuristic nhu cu. Dat SAU cache check:
	// warm hit khong phai tra chi phi index.
	const symbolIndex = await getSymbolIndex(repo.root).catch(() => null)

	const esc = escapeRegex(sym)
	// Heuristic nhan dien dinh nghia: class/interface/... <sym> | def/function/fn <sym>( | <visibility...> ... <sym>(
	const defRe = new RegExp(
		`(?:\\b(?:class|interface|struct|enum|record|namespace)\\s+[\\w.]*${esc}\\b|\\b(?:def|function|fn|func|sub)\\s+${esc}\\s*\\(|\\b(?:export|public|private|protected|internal|static|async|override|virtual|sealed|abstract|partial)\\b[^;{}]*\\b${esc}\\b\\s*\\()`,
	)

	const { lines, engine } = await grepLines(repo.root, `\\b${esc}\\b`, a.glob, 300)
	const matches = lines
		.map(parseLine)
		.filter((m): m is NonNullable<typeof m> => m !== null && !isDeniedRelPath(m.path))
		.slice(0, MAX_MATCHES)

	// Dinh nghia: uu tien symbol index (khop ten chinh xac theo AST); fallback regex.
	const indexDefs = symbolIndex?.byName.get(sym) ?? []
	let defs: Array<{ path: string; line: number; text: string }>
	let callers: typeof matches
	if (symbolIndex) {
		const defKeys = new Set(indexDefs.map((d) => `${d.path}:${d.line}`))
		defs = indexDefs.map((d) => ({ path: d.path, line: d.line, text: `${d.kind} ${d.name}` }))
		callers = matches.filter((m) => !defKeys.has(`${m.path}:${m.line}`))
	} else {
		defs = matches.filter((m) => defRe.test(m.text))
		callers = matches.filter((m) => !defRe.test(m.text))
	}

	let truncated = matches.length >= MAX_MATCHES

	// Doc body cac dinh nghia (gioi han maxFiles file) de hien logic + trich callees.
	const defByFile = new Map<string, typeof defs>()
	for (const d of defs) defByFile.set(d.path, [...(defByFile.get(d.path) ?? []), d])
	const defFiles = [...defByFile.keys()].slice(0, maxFiles)
	if (defByFile.size > defFiles.length) truncated = true

	const fingerprints: Fingerprint[] = []
	const definitions: DefEntry[] = []
	const calleeCount = new Map<string, number>()

	await mapLimit(defFiles, 8, async (path) => {
		for (const d of defByFile.get(path)!) {
			const body = await readBodyWindow(repo.root, d, bodyLines, fingerprints)
			if (body === null) {
				definitions.push({ path, line: d.line, snippet: d.text.trim().slice(0, 200) })
				continue
			}
			definitions.push({
				path,
				line: d.line,
				snippet: d.text.trim().slice(0, 200),
				body,
				body_end_line: d.line + bodyLines,
			})
			extractCalls(body, new Set([sym]), calleeCount)
		}
	})
	definitions.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line)

	const callerOut = callers.slice(0, MAX_CALLERS).map((c) => ({
		path: c.path,
		line: c.line,
		snippet: c.text.trim().slice(0, 200),
	}))
	if (callers.length > callerOut.length) truncated = true

	// Callees: top 5 theo tan suat. Truoc day moi ten 1 tien trinh rg (toi da 5
	// process); gio 1 luot rg duy nhat voi alternation, roi gan tung dong ve dung
	// ten bang regex JS trong process.
	const topCallees = [...calleeCount.entries()]
		.sort((x, y) => y[1] - x[1])
		.slice(0, TOP_CALLEES)
		.map(([n]) => n)

	const defReSrc = (esc: string) =>
		`\\b(?:class|interface|struct|enum|record)\\s+[\\w.]*${esc}\\b|` +
		`\\b(?:def|function|fn|func|sub)\\s+${esc}\\s*\\(|` +
		`\\b(?:export|public|private|protected|internal|static|async|override|virtual)\\b[^;{}]*\\b${esc}\\b\\s*\\(`

	const calleeLocs = new Map<string, Loc[]>()
	if (topCallees.length > 0) {
		if (symbolIndex) {
			// Lookup O(1) tren index — khong can them process rg nao cho callees.
			for (const name of topCallees) {
				const locs = (symbolIndex.byName.get(name) ?? [])
					.slice(0, 3)
					.map((d) => ({ path: d.path, line: d.line }))
				if (locs.length > 0) calleeLocs.set(name, locs)
			}
		} else {
			const combined = defReSrc(`(?:${topCallees.map(escapeRegex).join("|")})`)
			const r = await grepLines(repo.root, combined, a.glob, 100)
			const perName = topCallees.map((name) => ({ name, re: new RegExp(defReSrc(escapeRegex(name))) }))
			for (const l of r.lines) {
				const m = parseLine(l)
				if (!m || isDeniedRelPath(m.path)) continue
				for (const { name, re } of perName) {
					if (!re.test(m.text)) continue
					const arr = calleeLocs.get(name)
					if (arr) {
						if (arr.length < 3) arr.push({ path: m.path, line: m.line })
					} else {
						calleeLocs.set(name, [{ path: m.path, line: m.line }])
					}
					break
				}
			}
		}
	}

	const callees = await mapLimit(topCallees, 4, async (name) => {
		const locs = calleeLocs.get(name) ?? []
		const entry: { name: string; definitions: Loc[]; callees?: string[] } = { name, definitions: locs }

		// depth 2: doc body dinh nghia cua callee va liet ke no goi gi tiep (chi ten).
		if (depth >= 2) {
			const sub = new Map<string, number>()
			await mapLimit(locs.slice(0, 2), 4, async (loc) => {
				const body = await readBodyWindow(repo.root, loc, bodyLines, fingerprints)
				if (body !== null) extractCalls(body, new Set([sym, name]), sub)
			})
			entry.callees = [...sub.entries()]
				.sort((x, y) => y[1] - x[1])
				.slice(0, 5)
				.map(([n]) => n)
		}
		return entry
	})

	const result: TraceResult = {
		repo: repo.name,
		symbol: sym,
		engine,
		symbol_index: symbolIndex !== null,
		definitions,
		callers: callerOut,
		callees,
		total_matches: matches.length,
		truncated,
		cache_hit: false,
		elapsed_ms: Date.now() - t0,
		...(engine === "git-grep"
			? { note: "chua cai ripgrep nen dung git grep: chi tim trong file da track" }
			: {}),
	}

	// repoStamp da bat ca symbol/file moi chua commit qua git status — cache binh thuong.
	cachePut(cacheKey, fingerprints, result)
	return result
	})
}

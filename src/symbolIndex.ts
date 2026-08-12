/*
 * Symbol index in-process bang tree-sitter (WASM).
 *
 * trace_flow/featureContext truoc day doan definition bang regex — nhanh nhung
 * loi voi comment/chuoi va khong phan biet duoc ngu canh. Module nay parse AST
 * mot lan cho moi repo (cache theo repoStamp: HEAD + git status), roi tra loi
 * lookup ten symbol trong O(1).
 *
 * Moi loi (thieu wasm, grammar loi, repo qua lon...) deu khien getSymbolIndex
 * tra null — caller tu lui ve duong ripgrep heuristic cu. Index KHONG BAO GIO
 * duoc lam sap tool.
 */
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { tmpdir } from "node:os"
import { run } from "./exec.js"
import { mapLimit } from "./files/concurrency.js"
import { repoStamp } from "./contextCache.js"
import { isDeniedRelPath } from "./security/paths.js"

export type SymbolKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "struct"
	| "enum"
	| "record"
	| "type"
	| "trait"
	| "impl"
	| "namespace"
	| "module"
	| "constructor"

export type SymbolDef = {
	name: string
	kind: SymbolKind
	path: string
	line: number
	endLine: number
}

export type SymbolIndex = {
	stamp: string
	builtAt: number
	fileCount: number
	defCount: number
	byName: Map<string, SymbolDef[]>
	byFile: Map<string, SymbolDef[]>
}

/** Repo lon hon muc nay thi khong index — lui ve heuristic, tranh chiem RAM/CPU. */
const MAX_INDEX_FILES = 3_000
const MAX_FILE_BYTES = 512_000
/** Tran ghi cache dia (index repo rat lon van cache duoc, nhung khong qua khung). */
const DISK_MAX_BYTES = 20_000_000

type LangSpec = { wasm: string; nodes: Record<string, SymbolKind> }

const TS_NODES: Record<string, SymbolKind> = {
	function_declaration: "function",
	generator_function_declaration: "function",
	method_definition: "method",
	method_signature: "method",
	class_declaration: "class",
	abstract_class_declaration: "class",
	interface_declaration: "interface",
	enum_declaration: "enum",
	type_alias_declaration: "type",
	namespace_declaration: "namespace",
	internal_module: "namespace",
	module: "module",
}
const JS_NODES: Record<string, SymbolKind> = {
	function_declaration: "function",
	generator_function_declaration: "function",
	method_definition: "method",
	class_declaration: "class",
}
const CSHARP_NODES: Record<string, SymbolKind> = {
	class_declaration: "class",
	interface_declaration: "interface",
	struct_declaration: "struct",
	enum_declaration: "enum",
	record_declaration: "record",
	method_declaration: "method",
	constructor_declaration: "constructor",
	namespace_declaration: "namespace",
}
const PY_NODES: Record<string, SymbolKind> = {
	function_definition: "function",
	class_definition: "class",
}
const GO_NODES: Record<string, SymbolKind> = {
	function_declaration: "function",
	method_declaration: "method",
}
const RUST_NODES: Record<string, SymbolKind> = {
	function_item: "function",
	struct_item: "struct",
	enum_item: "enum",
	trait_item: "trait",
	impl_item: "impl",
	mod_item: "module",
}

const EXT_TO_LANG: Record<string, LangSpec> = {
	".ts": { wasm: "tree-sitter-typescript", nodes: TS_NODES },
	".mts": { wasm: "tree-sitter-typescript", nodes: TS_NODES },
	".cts": { wasm: "tree-sitter-typescript", nodes: TS_NODES },
	".tsx": { wasm: "tree-sitter-tsx", nodes: TS_NODES },
	".js": { wasm: "tree-sitter-javascript", nodes: JS_NODES },
	".jsx": { wasm: "tree-sitter-javascript", nodes: JS_NODES },
	".mjs": { wasm: "tree-sitter-javascript", nodes: JS_NODES },
	".cjs": { wasm: "tree-sitter-javascript", nodes: JS_NODES },
	".cs": { wasm: "tree-sitter-c_sharp", nodes: CSHARP_NODES },
	".py": { wasm: "tree-sitter-python", nodes: PY_NODES },
	".go": { wasm: "tree-sitter-go", nodes: GO_NODES },
	".rs": { wasm: "tree-sitter-rust", nodes: RUST_NODES },
}

/* ── Runtime tree-sitter (lazy, mot lan cho ca process) ─────────────────── */

/*
 * Kieu toi thieu tu dinh nghia (structural typing) thay vi lay tu package:
 * web-tree-sitter 0.22 export kieu CJS (module.exports = Parser) con 0.25 dung
 * named exports. Cach nay chay duoc ca hai ma khong phu thuoc .d.ts.
 */
type TreeSitterNode = {
	type: string
	text: string
	startPosition: { row: number; column: number }
	endPosition: { row: number; column: number }
	namedChildren: TreeSitterNode[]
	childForFieldName(name: string): TreeSitterNode | null
}
type TreeSitterTree = { rootNode: TreeSitterNode; delete(): void }
type TreeSitterParser = { parse(text: string): TreeSitterTree | null; setLanguage(lang: unknown): void }
type Runtime = { Parser: any; Language: any }

let runtimePromise: Promise<Runtime> | null = null
const parserCache = new Map<string, TreeSitterParser>()

/*
 * Resolve THU MUC package trong node_modules. Hai chien luoc vi ca hai deu co
 * truong hop that bai:
 *  - `${name}/package.json`: bi chan khi package co exports map khong expose no
 *    (web-tree-sitter: ERR_PACKAGE_PATH_NOT_EXPORTED).
 *  - entry point: bi chan khi main tro vao file khong ton tai
 *    (tree-sitter-wasms: main = "bindings/node" khong co that -> MODULE_NOT_FOUND).
 */
function resolvePkg(rel: string): string {
	const req = createRequire(import.meta.url)
	try {
		return dirname(req.resolve(`${rel}/package.json`))
	} catch {
		const entry = req.resolve(rel)
		const needle = `node_modules${sep}${rel}`
		const idx = entry.lastIndexOf(needle)
		if (idx >= 0) return entry.slice(0, idx + needle.length)
		let dir = dirname(entry)
		while (dir !== dirname(dir)) {
			if (existsSync(join(dir, "package.json"))) return dir
			dir = dirname(dir)
		}
		return dirname(entry)
	}
}

/** Tuong thich ca 0.22 (default export CJS) lan 0.25 (named exports ESM). */
async function runtime(): Promise<Runtime> {
	if (!runtimePromise) {
		runtimePromise = (async (): Promise<Runtime> => {
			// 0.22 la CJS thuan (module.exports = Parser): require cho ket qua truc
			// tiep, khoi qua lop interop cua ESM. 0.25 (named exports) thi import.
			const req = createRequire(import.meta.url)
			let mod: any
			try {
				mod = req("web-tree-sitter")
			} catch {
				mod = await import("web-tree-sitter")
			}
			const Parser = mod.Parser ?? mod.default ?? mod
			if (!Parser?.init) throw new Error("web-tree-sitter: khong tim thay Parser export")
			const pkgDir = resolvePkg("web-tree-sitter")
			// 0.22 dat ten tree-sitter.wasm; 0.25 doi thanh web-tree-sitter.wasm.
			const wasmName = existsSync(join(pkgDir, "tree-sitter.wasm")) ? "tree-sitter.wasm" : "web-tree-sitter.wasm"
			const wasm = join(pkgDir, wasmName)
			await Parser.init({ locateFile: () => wasm })
			// 0.22 chi gan Parser.Language BEN TRONG init() — phai doc sau khi init xong.
			const Language = Parser.Language ?? mod.Language
			if (!Language?.load) throw new Error("web-tree-sitter: khong tim thay Language export")
			return { Parser, Language }
		})()
	}
	return runtimePromise
}

async function parserFor(wasmName: string): Promise<TreeSitterParser> {
	const cached = parserCache.get(wasmName)
	if (cached) return cached
	const mod = await runtime()
	const wasm = join(resolvePkg("tree-sitter-wasms"), "out", `${wasmName}.wasm`)
	const lang = await mod.Language.load(wasm)
	const parser = new mod.Parser() as TreeSitterParser
	parser.setLanguage(lang)
	parserCache.set(wasmName, parser)
	return parser
}

/* ── Trich symbol tu AST ────────────────────────────────────────────────── */

function firstIdentifier(node: TreeSitterNode): TreeSitterNode | null {
	for (const child of node.namedChildren) {
		if (child.type === "identifier" || child.type === "type_identifier") return child
	}
	return null
}

function walk(node: TreeSitterNode, spec: LangSpec, relPath: string, defs: SymbolDef[], depth: number): void {
	if (depth > 60) return
	const kind = spec.nodes[node.type]
	if (kind) {
		const nameNode = node.childForFieldName("name") ?? firstIdentifier(node)
		if (nameNode && nameNode.text.length > 0 && nameNode.text.length <= 120) {
			defs.push({
				name: nameNode.text,
				kind,
				path: relPath,
				line: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			})
		}
	}
	for (const child of node.namedChildren) walk(child, spec, relPath, defs, depth + 1)
}

async function parseOne(root: string, relPath: string, spec: LangSpec): Promise<SymbolDef[]> {
	try {
		const abs = join(root, relPath)
		const st = await stat(abs)
		if (st.size > MAX_FILE_BYTES) return []
		const text = await readFile(abs, "utf8")
		const parser = await parserFor(spec.wasm)
		const tree = parser.parse(text)
		if (!tree) return []
		try {
			const defs: SymbolDef[] = []
			walk(tree.rootNode, spec, relPath, defs, 0)
			return defs
		} finally {
			tree.delete()
		}
	} catch {
		return [] // file loi cu the khong duoc lam hong ca index
	}
}

/* ── Cache: RAM + dia, key theo repoStamp ───────────────────────────────── */

const DISK_DIR = join(tmpdir(), "local-repo-mcp-symbol-cache")

function diskPath(root: string, stamp: string): string {
	const h = createHash("sha256").update(`${root} ${stamp}`).digest("hex")
	return join(DISK_DIR, `${h}.json`)
}

function assemble(stamp: string, fileCount: number, defs: SymbolDef[]): SymbolIndex {
	const byName = new Map<string, SymbolDef[]>()
	const byFile = new Map<string, SymbolDef[]>()
	for (const d of defs) {
		const bn = byName.get(d.name)
		if (bn) bn.push(d)
		else byName.set(d.name, [d])
		const bf = byFile.get(d.path)
		if (bf) bf.push(d)
		else byFile.set(d.path, [d])
	}
	return { stamp, builtAt: Date.now(), fileCount, defCount: defs.length, byName, byFile }
}

async function listIndexableFiles(root: string): Promise<string[]> {
	const exts = new Set(Object.keys(EXT_TO_LANG))
	const pick = (stdout: string): string[] =>
		stdout
			.split(/\r?\n/)
			.map((s) => s.trim().replace(/\\/g, "/"))
			.filter(Boolean)
			.filter((p) => exts.has(p.slice(p.lastIndexOf(".")).toLowerCase()))
			.filter((p) => !isDeniedRelPath(p))

	try {
		const r = await run(["rg", "--files", "--color", "never"], { cwd: root, timeoutMs: 30_000 })
		if (r.code === 0 || r.code === 1) return pick(r.stdout)
		throw new Error(`rg exit ${r.code}`)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (!msg.includes("ENOENT")) throw e
		const r = await run(["git", "ls-files"], { cwd: root, timeoutMs: 30_000 })
		return pick(r.stdout)
	}
}

async function buildIndex(root: string, stamp: string): Promise<SymbolIndex> {
	const all = await listIndexableFiles(root)
	const files = all.slice(0, MAX_INDEX_FILES)
	const groups = new Map<LangSpec, string[]>()
	for (const f of files) {
		const spec = EXT_TO_LANG[f.slice(f.lastIndexOf(".")).toLowerCase()]
		if (!spec) continue
		const arr = groups.get(spec)
		if (arr) arr.push(f)
		else groups.set(spec, [f])
	}

	const defs: SymbolDef[] = []
	for (const [spec, relPaths] of groups) {
		const batches = await mapLimit(relPaths, 8, (p) => parseOne(root, p, spec))
		for (const b of batches) defs.push(...b)
	}
	return assemble(stamp, files.length, defs)
}

const memCache = new Map<string, SymbolIndex>()
/** root -> stamp cua lan build gan nhat tra null (repo khong co symbol). Tranh build lai moi call. */
const nullStamps = new Map<string, string>()
const inflight = new Map<string, Promise<SymbolIndex | null>>()

/**
 * Lay symbol index cua repo o dung trang thai hien tai (repoStamp).
 * Tra null khi: khong co file ho tro, thieu wasm, hoac loi bat ky — caller phai
 * co duong fallback. Khong bao gio throw.
 */
export async function getSymbolIndex(root: string): Promise<SymbolIndex | null> {
	try {
		const stamp = await repoStamp(root)
		const mem = memCache.get(root)
		if (mem && mem.stamp === stamp) return mem
		if (nullStamps.get(root) === stamp) return null

		const key = `${root} ${stamp}`
		const pending = inflight.get(key)
		if (pending) return pending

		const p = (async (): Promise<SymbolIndex | null> => {
			// Tang dia truoc: song qua restart server.
			try {
				const raw = await readFile(diskPath(root, stamp), "utf8")
				const parsed = JSON.parse(raw) as { stamp: string; fileCount: number; defs: SymbolDef[] }
				if (parsed.stamp === stamp && Array.isArray(parsed.defs)) {
					return assemble(stamp, parsed.fileCount, parsed.defs)
				}
			} catch {}

			const idx = await buildIndex(root, stamp)
			if (idx.defCount === 0) return null // repo khong co ngon ngu ho tro

			try {
				const payload = JSON.stringify({ stamp, fileCount: idx.fileCount, defs: [...idx.byName.values()].flat() })
				if (payload.length <= DISK_MAX_BYTES) {
					await mkdir(DISK_DIR, { recursive: true })
					await writeFile(diskPath(root, stamp), payload, "utf8")
				}
			} catch {}
			return idx
		})()

		inflight.set(key, p)
		try {
			const idx = await p
			if (idx) memCache.set(root, idx)
			else nullStamps.set(root, stamp) // cache ca ket qua rong: repo khong co symbol
			return idx
		} finally {
			inflight.delete(key)
		}
	} catch {
		return null
	}
}

/**
 * Ep build lai index cho trang thai hien tai, bo qua moi cache (ke ca disk).
 * Index thuong tu invalidate theo repoStamp — ham nay chi can khi muon lam
 * tuoi chu dong (tool reindex).
 */
export async function forceRebuildSymbolIndex(root: string): Promise<SymbolIndex | null> {
	try {
		const stamp = await repoStamp(root)
		memCache.delete(root)
		nullStamps.delete(root)
		const idx = await buildIndex(root, stamp)
		if (idx.defCount === 0) {
			nullStamps.set(root, stamp)
			return null
		}
		memCache.set(root, idx)
		try {
			const payload = JSON.stringify({ stamp, fileCount: idx.fileCount, defs: [...idx.byName.values()].flat() })
			if (payload.length <= DISK_MAX_BYTES) {
				await mkdir(DISK_DIR, { recursive: true })
				await writeFile(diskPath(root, stamp), payload, "utf8")
			}
		} catch {}
		return idx
	} catch {
		return null
	}
}

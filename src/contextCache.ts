import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { run } from "./exec.js"
import { mapLimit } from "./files/concurrency.js"
import { allRepos } from "./repos.js"
import { safeResolve } from "./security/paths.js"

/*
 * Cache dung chung cho cac tool doc context (get_feature_context, trace_flow).
 *
 * Hai lop chong du lieu cu:
 *  1. Key gan voi repoStamp (HEAD + git status) — commit moi hoac file moi/bi xoa
 *     chua commit deu tu lam cache cu khong trung nua.
 *  2. Fingerprint (size + mtimeMs) cua tung file da doc — bat sua noi dung CHUA commit.
 *     Fingerprint khop thi noi dung khong the khac.
 *
 * Nho vay TTL co the dai (30 phut) thay vi vai giay nhu glob cache.
 */
export type Fingerprint = { path: string; size: number; mtimeMs: number }

// TTL 6h: HEAD + fingerprint da bao ve tinh dung, nen dai cung an toan.
const TTL_MS = 6 * 60 * 60_000
const MAX_ENTRIES = 200

const store = new Map<string, { expiresAt: number; fingerprints: Fingerprint[]; result: unknown }>()

/* Tang dia: tmpdir, moi key 1 file sha256(key).json — cache song qua restart server/exe. */
const DISK_DIR = join(tmpdir(), "local-repo-mcp-context-cache")
const DISK_MAX_BYTES = 5_000_000
const pendingWrites = new Set<Promise<void>>()

function diskPath(key: string): string {
	return join(DISK_DIR, `${createHash("sha256").update(key).digest("hex")}.json`)
}

const HEAD_TTL_MS = 10_000
const headCache = new Map<string, { at: number; sha: string }>()

/** SHA cua HEAD, cache 10s. Repo khong phai git (hoac git loi) tra "nohead" — cache van hoat dong. */
export async function headSha(root: string): Promise<string> {
	const hit = headCache.get(root)
	if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.sha
	let sha = "nohead"
	try {
		const r = await run(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })
		if (r.code === 0 && r.stdout.trim()) sha = r.stdout.trim()
	} catch {}
	headCache.set(root, { at: Date.now(), sha })
	return sha
}

const stampCache = new Map<string, { at: number; stamp: string }>()
const STAMP_TTL_MS = 2_000

/**
 * Con dau trang thai repo: HEAD + hash cua `git status --porcelain`.
 * HEAD bat thay doi da commit; status bat file MOI/BI XOA chua commit — thu ma
 * fingerprint khong nhin thay (fingerprint chi kiem file da nam trong ket qua).
 * TTL ngan 2s: phat hien thay doi tre nhat 2s; gia tri stamp khong doi khi tree
 * khong doi, nen cache key van on dinh trong mot phien nghien cuu.
 */
export async function repoStamp(root: string): Promise<string> {
	const hit = stampCache.get(root)
	if (hit && Date.now() - hit.at < STAMP_TTL_MS) return hit.stamp
	const head = await headSha(root)
	let statusHash = "clean"
	try {
		const r = await run(["git", "status", "--porcelain"], { cwd: root, timeoutMs: 10_000 })
		if (r.code === 0) {
			const out = r.stdout.trim()
			if (out) statusHash = createHash("sha256").update(out).digest("hex").slice(0, 12)
		}
	} catch {}
	const stamp = `${head}:${statusHash}`
	stampCache.set(root, { at: Date.now(), stamp })
	return stamp
}

async function fingerprintsValid(root: string, fps: Fingerprint[]): Promise<boolean> {
	const checks = await mapLimit(fps, 16, async (fp) => {
		try {
			const abs = safeResolve(root, fp.path)
			const s = await stat(abs)
			return s.size === fp.size && s.mtimeMs === fp.mtimeMs
		} catch {
			return false
		}
	})
	return checks.every(Boolean)
}

export async function cacheGet<T>(key: string, root: string): Promise<T | null> {
	const hit = store.get(key)
	if (hit) {
		if (hit.expiresAt <= Date.now() || !(await fingerprintsValid(root, hit.fingerprints))) {
			store.delete(key)
			return null
		}
		return hit.result as T
	}
	// Miss RAM thi doc dia (cache song qua restart), roi warm lai RAM.
	try {
		const raw = await readFile(diskPath(key), "utf8")
		const disk = JSON.parse(raw) as { expiresAt: number; fingerprints: Fingerprint[]; result: T }
		if (disk.expiresAt <= Date.now() || !(await fingerprintsValid(root, disk.fingerprints))) return null
		store.set(key, disk)
		return disk.result
	} catch {
		return null
	}
}

export function cachePut(key: string, fingerprints: Fingerprint[], result: unknown): void {
	if (store.size >= MAX_ENTRIES) {
		const oldest = store.keys().next().value
		if (oldest !== undefined) store.delete(oldest)
	}
	const entry = { expiresAt: Date.now() + TTL_MS, fingerprints, result }
	store.set(key, entry)
	try {
		const payload = JSON.stringify(entry)
		if (payload.length > DISK_MAX_BYTES) return
		const p = (async () => {
			await mkdir(DISK_DIR, { recursive: true })
			await writeFile(diskPath(key), payload, "utf8")
		})().catch(() => {})
		pendingWrites.add(p)
		void p.finally(() => pendingWrites.delete(p))
	} catch {}
}

/*
 * Dedup cac tinh toan giong nhau dang chay: call thu hai cung key doi chung
 * promise cua call thu nhat thay vi compute lai (agent hay goi song song).
 */
const inflight = new Map<string, Promise<unknown>>()

export async function cacheInflight<T>(key: string, compute: () => Promise<T>): Promise<T> {
	const pending = inflight.get(key)
	if (pending) return pending as Promise<T>
	const p = compute().finally(() => inflight.delete(key))
	inflight.set(key, p)
	return p
}

/** Chi cho test: cho moi ghi dia dang treo hoan tat. */
export async function flushContextCacheWrites(): Promise<void> {
	await Promise.allSettled([...pendingWrites])
}

/**
 * Lay san SHA cua moi repo luc server khoi dong de query dau tien khong phai cho
 * 1 tien trinh git. Fire-and-forget — loi bo qua, query dau se tu lay lai.
 */
export async function prewarmHeads(): Promise<void> {
	try {
		await mapLimit(allRepos(), 4, async (r) => {
			await headSha(r.root)
		})
	} catch {}
	// Don file cache het han tren dia (ngoai ra cacheGet tu xoa khi doc trung).
	try {
		const now = Date.now()
		await mkdir(DISK_DIR, { recursive: true })
		for (const f of await readdir(DISK_DIR)) {
			if (!f.endsWith(".json")) continue
			const fp = join(DISK_DIR, f)
			try {
				const parsed = JSON.parse(await readFile(fp, "utf8")) as { expiresAt?: number }
				if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) await unlink(fp)
			} catch {
				await unlink(fp).catch(() => {})
			}
		}
	} catch {}
}

import { appendFile, rename, stat } from "node:fs/promises"

const FILE = "audit.log"
const MAX_BYTES = 5_000_000 // rotate 1 vong: audit.log -> audit.log.1
const MAX_STRING = 200 // do dai toi da cho moi truong string

/** Truong luon chua noi dung file hoac lenh dai/secret, khong bao gio duoc ghi nguyen van. */
const ALWAYS_ELIDE = new Set(["content", "new_str", "old_str", "command", "patch_text", "data"])

export function redactForAudit(args: unknown): unknown {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return args
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		if (k === "env" && v && typeof v === "object") {
			out[k] = `<env: ${Object.keys(v).length} keys, khong ghi noi dung>`
			continue
		}
		if (typeof v !== "string") {
			out[k] = v
			continue
		}
		out[k] =
			ALWAYS_ELIDE.has(k) || v.length > MAX_STRING
				? `<${k}: ${v.length} chars, khong ghi noi dung>`
				: v
	}
	return out
}

/*
 * Ghi bat dong bo theo lo. Audit nam tren duong nong cua MOI tool call; ban cu
 * appendFileSync + statSync chan event loop tung lan. Loi ghi van bi bo qua nhu
 * truoc (audit khong bao gio duoc lam sap tool call).
 */
let queue: string[] = []
let flushing = false

async function flush(): Promise<void> {
	if (flushing) return
	flushing = true
	try {
		while (queue.length > 0) {
			const chunk = queue.splice(0, queue.length).join("")
			try {
				const st = await stat(FILE).catch(() => null)
				if (st && st.size > MAX_BYTES) await rename(FILE, `${FILE}.1`).catch(() => {})
				await appendFile(FILE, chunk)
			} catch {}
		}
	} finally {
		flushing = false
	}
}

export function audit(tool: string, args: unknown, ok: boolean, note = "") {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		tool,
		args: redactForAudit(args),
		ok,
		note: note.slice(0, 2_000),
	})
	// Cap queue: neu ghi dia loi lien tuc thi drop bot dong cu nhat,
	// thay vi de queue phinh RAM vo han.
	if (queue.length >= 10_000) queue.splice(0, queue.length - 10_000)
	queue.push(line + "\n")
	void flush()
}

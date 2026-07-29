import { appendFileSync, renameSync, statSync } from "node:fs"

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

function rotateIfNeeded() {
	try {
		if (statSync(FILE).size > MAX_BYTES) renameSync(FILE, `${FILE}.1`)
	} catch {} // chua co file, hoac khong rotate duoc: cu ghi tiep
}

export function audit(tool: string, args: unknown, ok: boolean, note = "") {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		tool,
		args: redactForAudit(args),
		ok,
		note: note.slice(0, 2_000),
	})
	try {
		rotateIfNeeded()
		appendFileSync(FILE, line + "\n")
	} catch {}
}

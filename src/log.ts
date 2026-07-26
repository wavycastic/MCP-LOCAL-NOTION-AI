import { appendFileSync } from "node:fs"

export function audit(tool: string, args: unknown, ok: boolean, note = "") {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		tool,
		args,
		ok,
		note,
	})
	try {
		appendFileSync("audit.log", line + "\n")
	} catch {}
}

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { hashBuffer } from "./text.js"

export type AtomicWriteResult = {
	changed: boolean
	sha256_after: string
	bytes_after: number
}

export function formatTextForWrite(text: string, bom: boolean, eol: "lf" | "crlf"): string {
	// Standardize to LF first
	let formatted = text.replace(/\r\n/g, "\n")
	if (eol === "crlf") {
		formatted = formatted.replace(/\n/g, "\r\n")
	}
	if (bom) {
		if (!formatted.startsWith("\ufeff")) {
			formatted = "\ufeff" + formatted
		}
	} else if (formatted.startsWith("\ufeff")) {
		formatted = formatted.slice(1)
	}
	return formatted
}

export function atomicWriteText(args: {
	abs: string
	text: string
	bom: boolean
	eol: "lf" | "crlf"
	mode?: number
}): AtomicWriteResult {
	const formattedStr = formatTextForWrite(args.text, args.bom, args.eol)
	const outputBuf = Buffer.from(formattedStr, "utf8")
	const sha256_after = hashBuffer(outputBuf)
	const bytes_after = outputBuf.length

	if (existsSync(args.abs)) {
		try {
			const existingBuf = readFileSync(args.abs)
			const existingHash = hashBuffer(existingBuf)
			if (existingHash === sha256_after) {
				return {
					changed: false,
					sha256_after,
					bytes_after,
				}
			}
		} catch {}
	}

	const tmpPath = `${args.abs}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
	try {
		writeFileSync(tmpPath, outputBuf, { flag: "wx", mode: args.mode })
		renameSync(tmpPath, args.abs)
		return {
			changed: true,
			sha256_after,
			bytes_after,
		}
	} catch (e) {
		try {
			if (existsSync(tmpPath)) {
				unlinkSync(tmpPath)
			}
		} catch {}
		throw e
	}
}

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"

export type TextSnapshot = {
	buffer: Buffer
	text: string
	sha256: string
	sizeBytes: number
	bom: boolean
	eol: "lf" | "crlf"
	mode?: number
}

export function hashBuffer(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex")
}

export function decodeStrictUtf8(buf: Buffer): { text: string; bom: boolean } {
	// Check for byte NUL
	if (buf.includes(0)) {
		throw new Error("File contains NUL bytes (binary files not supported)")
	}

	// Check UTF-8 BOM (0xEF, 0xBB, 0xBF)
	const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
	const slice = hasBom ? buf.subarray(3) : buf

	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(slice)
		return { text, bom: hasBom }
	} catch (e) {
		throw new Error(`File is not valid UTF-8: ${e instanceof Error ? e.message : String(e)}`)
	}
}

export function detectEol(text: string): "lf" | "crlf" {
	const crlfCount = (text.match(/\r\n/g) ?? []).length
	if (crlfCount === 0) return "lf"
	const lfTotal = (text.match(/\n/g) ?? []).length
	return crlfCount >= lfTotal - crlfCount ? "crlf" : "lf"
}

/** Async variant used by bounded-parallel batch tools. */
export async function readTextSnapshotAsync(abs: string): Promise<TextSnapshot> {
	const [buffer, st] = await Promise.all([
		readFile(abs),
		stat(abs).catch(() => undefined),
	])
	const { text, bom } = decodeStrictUtf8(buffer)
	return {
		buffer,
		text,
		sha256: hashBuffer(buffer),
		sizeBytes: buffer.length,
		bom,
		eol: detectEol(text),
		mode: st?.mode,
	}
}

export function readTextSnapshot(abs: string): TextSnapshot {
	const buffer = readFileSync(abs)
	let mode: number | undefined
	try {
		mode = statSync(abs).mode
	} catch {}

	const { text, bom } = decodeStrictUtf8(buffer)
	const sha256 = hashBuffer(buffer)
	const eol = detectEol(text)

	return {
		buffer,
		text,
		sha256,
		sizeBytes: buffer.length,
		bom,
		eol,
		mode,
	}
}

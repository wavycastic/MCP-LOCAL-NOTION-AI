import { createHash } from "node:crypto"
import { MAX_WRITE_BYTES } from "../config.js"
import type { FileOperation, FileSnapshot, PatchPlan, PlannedChange } from "./types.js"

const toLf = (s: string) => s.replace(/\r\n/g, "\n")
const toCrlf = (s: string) => toLf(s).replace(/\n/g, "\r\n")

function replaceFirst(parts: string[], oldStr: string, newStr: string): string {
	return parts[0] + newStr + parts.slice(1).join(oldStr)
}

function hasBom(s: string): boolean {
	return s.charCodeAt(0) === 0xfeff
}

export function buildPlan(operations: FileOperation[], snapshots: Map<string, FileSnapshot>): PatchPlan {
	const changes: PlannedChange[] = []
	let totalAdditions = 0
	let totalDeletions = 0

	for (const op of operations) {
		if (op.kind === "add") {
			const newContent = op.lines.join("\n") + (op.lines.length > 0 ? "\n" : "")
			const bytesAfter = Buffer.byteLength(newContent, "utf8")
			if (bytesAfter > MAX_WRITE_BYTES) {
				throw new Error(
					`Add File '${op.path}' vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES} (nang ${bytesAfter} bytes)`,
				)
			}
			const sha256After = createHash("sha256").update(newContent).digest("hex")
			totalAdditions += op.lines.length
			changes.push({
				type: "add",
				path: op.path,
				newContent,
				bytesAfter,
				sha256After,
			})
			continue
		}

		if (op.kind === "delete") {
			const snap = snapshots.get(op.path)
			if (!snap || !snap.existed || snap.content === undefined) {
				throw new Error(`Delete File target khong ton tai: '${op.path}'`)
			}
			const oldContent = snap.content
			const bytesBefore = Buffer.byteLength(oldContent, "utf8")
			const sha256Before = snap.sha256 ?? createHash("sha256").update(oldContent).digest("hex")
			const oldLines = oldContent.split("\n").length
			totalDeletions += oldLines
			changes.push({
				type: "delete",
				path: op.path,
				oldContent,
				bytesBefore,
				sha256Before,
			})
			continue
		}

		if (op.kind === "update") {
			const snap = snapshots.get(op.path)
			if (!snap || !snap.existed || snap.content === undefined) {
				throw new Error(`Update File target khong ton tai: '${op.path}'`)
			}

			const raw = snap.content
			const crlf = snap.eol === "crlf"
			const bom = snap.bom ?? hasBom(raw)
			const cleanRaw = bom ? raw.slice(1) : raw

			let currentSrc = cleanRaw
			let totalReplacements = 0

			for (let hIdx = 0; hIdx < op.hunks.length; hIdx++) {
				const hunk = op.hunks[hIdx]
				const oldLines: string[] = []
				const newLines: string[] = []

				for (const line of hunk.lines) {
					if (line.type === "context") {
						oldLines.push(line.text)
						newLines.push(line.text)
					} else if (line.type === "delete") {
						oldLines.push(line.text)
						totalDeletions++
					} else if (line.type === "add") {
						newLines.push(line.text)
						totalAdditions++
					}
				}

				let oldBlock = oldLines.join("\n")
				let newBlock = newLines.join("\n")

				let src = currentSrc
				if (!src.includes(oldBlock)) {
					const lfSrc = toLf(src)
					const lfOld = toLf(oldBlock)
					if (lfOld.length > 0 && lfSrc.includes(lfOld)) {
						src = lfSrc
						oldBlock = lfOld
						newBlock = toLf(newBlock)
					}
				}

				const parts = src.split(oldBlock)
				const n = parts.length - 1

				if (n === 0) {
					const headerMsg = hunk.header ? ` (header: @@ ${hunk.header})` : ""
					throw new Error(
						`apply_patch verification failed: '${op.path}' hunk #${hunk.header ? hunk.header : hIdx + 1}${headerMsg} khong tim thay trong file`,
					)
				}
				if (n > 1) {
					const headerMsg = hunk.header ? ` (header: @@ ${hunk.header})` : ""
					throw new Error(
						`apply_patch verification failed: '${op.path}' hunk #${hunk.header ? hunk.header : hIdx + 1}${headerMsg} khop ${n} vi tri (ambiguous). Hay them context hoac @@ header doc nhat.`,
					)
				}

				currentSrc = replaceFirst(parts, oldBlock, newBlock)
				totalReplacements += n
			}

			let finalStr = crlf ? toCrlf(currentSrc) : currentSrc
			if (bom) finalStr = "\ufeff" + finalStr

			const bytesBefore = Buffer.byteLength(raw, "utf8")
			const bytesAfter = Buffer.byteLength(finalStr, "utf8")
			if (bytesAfter > MAX_WRITE_BYTES) {
				throw new Error(
					`sau khi update '${op.path}', file se nang ${bytesAfter} bytes, vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES}`,
				)
			}

			const sha256Before = snap.sha256 ?? createHash("sha256").update(raw).digest("hex")
			const sha256After = createHash("sha256").update(finalStr).digest("hex")

			const hunkDiffLines: string[] = []
			for (let hIdx = 0; hIdx < op.hunks.length; hIdx++) {
				const hunk = op.hunks[hIdx]
				hunkDiffLines.push(`@@ ${hunk.header ? hunk.header : `hunk ${hIdx + 1}`} @@`)
				for (const line of hunk.lines) {
					if (line.type === "context") hunkDiffLines.push(` ${line.text}`)
					else if (line.type === "delete") hunkDiffLines.push(`-${line.text}`)
					else if (line.type === "add") hunkDiffLines.push(`+${line.text}`)
				}
			}
			const hunkDiff = hunkDiffLines.join("\n")

			if (op.moveTo) {
				changes.push({
					type: "move",
					from: op.path,
					to: op.moveTo,
					oldContent: raw,
					newContent: finalStr,
					bytesBefore,
					bytesAfter,
					sha256Before,
					sha256After,
					replacements: totalReplacements,
					hunkDiff,
				})
			} else {
				changes.push({
					type: "update",
					path: op.path,
					oldContent: raw,
					newContent: finalStr,
					bytesBefore,
					bytesAfter,
					sha256Before,
					sha256After,
					replacements: totalReplacements,
					hunkDiff,
				})
			}
		}
	}

	return { changes, totalAdditions, totalDeletions }
}

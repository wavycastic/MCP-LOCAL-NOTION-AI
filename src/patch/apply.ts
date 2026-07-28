import { MAX_WRITE_BYTES } from "../config.js"
import { applyReplacements, findTextMatches } from "../files/matcher.js"
import { formatTextForWrite } from "../files/atomicWrite.js"
import { hashBuffer } from "../files/text.js"
import type { FileOperation, FileSnapshot, PatchPlan, PlannedChange } from "./types.js"

export function buildPlan(operations: FileOperation[], snapshots: Map<string, FileSnapshot>): PatchPlan {
	const changes: PlannedChange[] = []
	let totalAdditions = 0
	let totalDeletions = 0

	for (const op of operations) {
		if (op.kind === "add") {
			const rawNewContent = op.lines.join("\n") + (op.lines.length > 0 ? "\n" : "")
			const formattedContent = formatTextForWrite(rawNewContent, false, "lf")
			const bytesAfter = Buffer.byteLength(formattedContent, "utf8")
			if (bytesAfter > MAX_WRITE_BYTES) {
				throw new Error(
					`Add File '${op.path}' vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES} (nang ${bytesAfter} bytes)`,
				)
			}
			const sha256After = hashBuffer(Buffer.from(formattedContent, "utf8"))
			totalAdditions += op.lines.length
			changes.push({
				type: "add",
				path: op.path,
				newContent: formattedContent,
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
			const sha256Before = snap.sha256 ?? hashBuffer(Buffer.from(oldContent, "utf8"))
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
			const bom = snap.bom ?? false
			const cleanRaw = bom && raw.startsWith("\ufeff") ? raw.slice(1) : raw

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

				const oldBlock = oldLines.join("\n")
				const newBlock = newLines.join("\n")

				const matches = findTextMatches({ source: currentSrc, needle: oldBlock })
				const n = matches.length

				const headerMsg = hunk.header ? ` (header: @@ ${hunk.header})` : ""
				const hunkLabel = hunk.header ? hunk.header : hIdx + 1

				if (n === 0) {
					throw new Error(
						`apply_patch verification failed: '${op.path}' hunk #${hunkLabel}${headerMsg} khong tim thay trong file`,
					)
				}
				if (n > 1) {
					throw new Error(
						`apply_patch verification failed: '${op.path}' hunk #${hunkLabel}${headerMsg} khop ${n} vi tri (ambiguous). Hay them context hoac @@ header doc nhat.`,
					)
				}

				currentSrc = applyReplacements(currentSrc, [matches[0]], newBlock)
				totalReplacements += n
			}

			const finalStr = formatTextForWrite(currentSrc, bom, crlf ? "crlf" : "lf")
			const bytesBefore = Buffer.byteLength(raw, "utf8")
			const bytesAfter = Buffer.byteLength(finalStr, "utf8")
			if (bytesAfter > MAX_WRITE_BYTES) {
				throw new Error(
					`sau khi update '${op.path}', file se nang ${bytesAfter} bytes, vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES}`,
				)
			}

			const sha256Before = snap.sha256 ?? hashBuffer(Buffer.from(raw, "utf8"))
			const sha256After = hashBuffer(Buffer.from(finalStr, "utf8"))

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

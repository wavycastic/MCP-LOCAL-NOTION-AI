import type {
	AddFileOp,
	DeleteFileOp,
	FileOperation,
	Hunk,
	HunkLine,
	ParsedPatch,
	UpdateFileOp,
} from "./types.js"

export const MAX_PATCH_BYTES = 5_000_000 // 5MB
export const MAX_PATCH_FILES = 100
export const MAX_PATCH_HUNKS = 500

export function parsePatch(patchText: string): ParsedPatch {
	const bytes = Buffer.byteLength(patchText, "utf8")
	if (bytes > MAX_PATCH_BYTES) {
		throw new Error(`patch_text nang ${bytes} bytes, vuot gioi han MAX_PATCH_BYTES=${MAX_PATCH_BYTES}`)
	}

	const normalized = patchText.replace(/\r\n/g, "\n")
	const lines = normalized.split("\n")

	// Find envelope boundaries
	const beginIdx = lines.findIndex((l) => l.trim() === "*** Begin Patch")
	if (beginIdx === -1) {
		throw new Error("apply_patch parsing failed: thieu header '*** Begin Patch'")
	}

	const endIdx = lines.findIndex((l, idx) => idx > beginIdx && l.trim() === "*** End Patch")
	if (endIdx === -1) {
		throw new Error("apply_patch parsing failed: thieu footer '*** End Patch'")
	}

	const patchLines = lines.slice(beginIdx + 1, endIdx)
	if (patchLines.every((l) => l.trim() === "")) {
		throw new Error("apply_patch parsing failed: patch_text rong (khong co file operation nào)")
	}

	const operations: FileOperation[] = []
	let currentOp: FileOperation | null = null
	let currentHunk: Hunk | null = null
	let totalHunks = 0

	function finishCurrentHunk() {
		if (currentHunk && currentOp && currentOp.kind === "update") {
			currentOp.hunks.push(currentHunk)
			currentHunk = null
		}
	}

	function finishCurrentOp() {
		finishCurrentHunk()
		if (currentOp) {
			if (currentOp.kind === "add" && currentOp.lines.length === 0) {
				// Empty file addition is allowed, but ensure operation is recorded
			}
			if (currentOp.kind === "update" && currentOp.hunks.length === 0 && !currentOp.moveTo) {
				throw new Error(`apply_patch parsing failed: Update File '${currentOp.path}' khong co hunk nao`)
			}
			operations.push(currentOp)
			currentOp = null
		}
	}

	for (let i = 0; i < patchLines.length; i++) {
		const line = patchLines[i]

		// Skip trailing empty lines before next operation
		if (!currentOp && line.trim() === "") continue

		if (line.startsWith("*** Add File: ")) {
			finishCurrentOp()
			if (operations.length >= MAX_PATCH_FILES) {
				throw new Error(`patch_text vuot MAX_PATCH_FILES=${MAX_PATCH_FILES}`)
			}
			const path = line.slice("*** Add File: ".length).trim()
			if (!path) throw new Error("apply_patch parsing failed: Add File thieu path")
			currentOp = { kind: "add", path, lines: [] }
			continue
		}

		if (line.startsWith("*** Delete File: ")) {
			finishCurrentOp()
			if (operations.length >= MAX_PATCH_FILES) {
				throw new Error(`patch_text vuot MAX_PATCH_FILES=${MAX_PATCH_FILES}`)
			}
			const path = line.slice("*** Delete File: ".length).trim()
			if (!path) throw new Error("apply_patch parsing failed: Delete File thieu path")
			currentOp = { kind: "delete", path }
			continue
		}

		if (line.startsWith("*** Update File: ")) {
			finishCurrentOp()
			if (operations.length >= MAX_PATCH_FILES) {
				throw new Error(`patch_text vuot MAX_PATCH_FILES=${MAX_PATCH_FILES}`)
			}
			const path = line.slice("*** Update File: ".length).trim()
			if (!path) throw new Error("apply_patch parsing failed: Update File thieu path")
			currentOp = { kind: "update", path, hunks: [] }
			continue
		}

		if (currentOp) {
			if (currentOp.kind === "add") {
				if (!line.startsWith("+")) {
					throw new Error(
						`apply_patch parsing failed: Add File '${currentOp.path}' dong #${i + 1} phai bat dau bang '+'`,
					)
				}
				currentOp.lines.push(line.slice(1))
				continue
			}

			if (currentOp.kind === "delete") {
				if (line.trim() !== "") {
					throw new Error(`apply_patch parsing failed: Delete File '${currentOp.path}' co dong du thua khong hop le`)
				}
				continue
			}

			if (currentOp.kind === "update") {
				if (line.startsWith("*** Move to: ")) {
					if (currentOp.hunks.length > 0 || currentHunk) {
						throw new Error(
							`apply_patch parsing failed: '*** Move to:' phai dat ngay sau '*** Update File:' cua '${currentOp.path}'`,
						)
					}
					const moveTo = line.slice("*** Move to: ".length).trim()
					if (!moveTo) throw new Error("apply_patch parsing failed: Move to thieu path target")
					currentOp.moveTo = moveTo
					continue
				}

				if (line.startsWith("@@")) {
					finishCurrentHunk()
					totalHunks++
					if (totalHunks > MAX_PATCH_HUNKS) {
						throw new Error(`patch_text vuot MAX_PATCH_HUNKS=${MAX_PATCH_HUNKS}`)
					}
					const header = line.slice(2).trim()
					currentHunk = { header: header || undefined, lines: [] }
					continue
				}

				if (currentHunk) {
					if (line.startsWith(" ")) {
						currentHunk.lines.push({ type: "context", text: line.slice(1) })
					} else if (line.startsWith("-")) {
						currentHunk.lines.push({ type: "delete", text: line.slice(1) })
					} else if (line.startsWith("+")) {
						currentHunk.lines.push({ type: "add", text: line.slice(1) })
					} else {
						throw new Error(
							`apply_patch parsing failed: Update File '${currentOp.path}' dong #${i + 1} phai bat dau bang ' ', '-', hoac '+'`,
						)
					}
					continue
				}
			}
		} else {
			if (line.trim() !== "") {
				throw new Error(`apply_patch parsing failed: dong khong thuoc operation pham vi: '${line}'`)
			}
		}
	}

	finishCurrentOp()

	if (operations.length === 0) {
		throw new Error("apply_patch parsing failed: khong co file operation nao hop le trong patch")
	}

	return { operations }
}

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { z } from "zod"
import { MAX_WRITE_BYTES } from "../config.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"
import { safeResolve } from "../security/paths.js"
import { noteTouched } from "../touched.js"

export const multiEditFileSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	path: z.string().describe("Duong dan tuong doi so voi repo root"),
	expected_sha256: z
		.string()
		.optional()
		.describe("Hash sha256 cua noi dung file luc doc. Neu truyen va khong khop, ngung sua de tranh troi troot code"),
	edits: z
		.array(
			z.object({
				old_str: z.string().describe("Doan text can thay"),
				new_str: z.string().describe("Doan text thay vao"),
				replace_all: z.boolean().optional().describe("Mac dinh false: old_str phai la duy nhat trong file"),
			}),
		)
		.min(1)
		.max(50)
		.describe("Danh sach cac thay doi can ap dung nguyen tu (all-or-nothing) trong 1 lan goi duy nhat"),
}

const toLf = (s: string) => s.replace(/\r\n/g, "\n")
const toCrlf = (s: string) => toLf(s).replace(/\n/g, "\r\n")

function isCrlfFile(raw: string): boolean {
	const crlf = (raw.match(/\r\n/g) ?? []).length
	if (crlf === 0) return false
	const lfTotal = (raw.match(/\n/g) ?? []).length
	return crlf >= lfTotal - crlf
}

function stripTrailing(s: string): string {
	return s
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")
}

function replaceFirst(parts: string[], oldStr: string, newStr: string): string {
	return parts[0] + newStr + parts.slice(1).join(oldStr)
}

type SingleEditResult = {
	index: number
	replacements: number
	match_mode: "exact" | "eol_normalized" | "trailing_whitespace_normalized"
}

export async function multiEditFile(a: {
	repo?: string
	path: string
	expected_sha256?: string
	edits: Array<{ old_str: string; new_str: string; replace_all?: boolean }>
}) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	const abs = safeResolve(repo.root, a.path)
	const raw = readFileSync(abs, "utf8")
	const crlf = isCrlfFile(raw)

	if (a.expected_sha256) {
		const actualHash = createHash("sha256").update(raw).digest("hex")
		if (actualHash !== a.expected_sha256) {
			throw new Error(
				`expected_sha256 mismatch for ${a.path}. Expected: ${a.expected_sha256}, Actual: ${actualHash}. File nay da bi thay doi sau khi doc.`,
			)
		}
	}

	let currentSrc = raw
	const editResults: SingleEditResult[] = []

	for (let i = 0; i < a.edits.length; i++) {
		const edit = a.edits[i]
		let src = currentSrc
		let oldStr = edit.old_str
		let newStr = edit.new_str
		let matchMode: SingleEditResult["match_mode"] = "exact"

		if (!src.includes(oldStr)) {
			const lfSrc = toLf(src)
			const lfOld = toLf(oldStr)
			if (lfOld.length > 0 && lfSrc.includes(lfOld)) {
				src = lfSrc
				oldStr = lfOld
				newStr = toLf(edit.new_str)
				matchMode = "eol_normalized"
			} else {
				// Tier 3: trailing-whitespace-normalized
				const trSrc = stripTrailing(lfSrc)
				const trOld = stripTrailing(lfOld)
				const trParts = trSrc.split(trOld)
				const trCount = trParts.length - 1

				if (trCount === 0) {
					throw new Error(
						`Edit #${i + 1} that bai: old_str khong tim thay trong ${a.path}. ` +
							`Cac edit truoc do trong batch da duoc ROLLBACK (file chua bi thay doi tren o dia).`,
					)
				}
				if (trCount > 1 && !edit.replace_all) {
					throw new Error(
						`Edit #${i + 1} that bai: old_str (sau khi bo qua khoang trang) khop ${trCount} cho trong ${a.path}. ` +
							`Mo rong old_str cho duy nhat hoac dat replace_all=true. Cac edit truoc do da duoc ROLLBACK.`,
					)
				}

				src = lfSrc
				oldStr = lfOld
				newStr = toLf(edit.new_str)
				matchMode = "trailing_whitespace_normalized"
			}
		}

		const parts = src.split(oldStr)
		const n = parts.length - 1
		if (n === 0) {
			throw new Error(
				`Edit #${i + 1} that bai: old_str khong tim thay trong ${a.path}. ` +
					`Cac edit truoc do trong batch da duoc ROLLBACK (file chua bi thay doi tren o dia).`,
			)
		}
		if (n > 1 && !edit.replace_all) {
			throw new Error(
				`Edit #${i + 1} that bai: old_str khop ${n} cho trong ${a.path}. ` +
					`Mo rong old_str cho duy nhat hoac dat replace_all=true. Cac edit truoc do da duoc ROLLBACK.`,
			)
		}

		currentSrc = edit.replace_all ? parts.join(newStr) : replaceFirst(parts, oldStr, newStr)
		editResults.push({ index: i + 1, replacements: edit.replace_all ? n : 1, match_mode: matchMode })
	}

	const finalContent = crlf ? toCrlf(currentSrc) : currentSrc
	const bytes = Buffer.byteLength(finalContent, "utf8")
	if (bytes > MAX_WRITE_BYTES) {
		throw new Error(
			`sau khi multi_edit_file, ${a.path} se nang ${bytes} bytes, vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES}`,
		)
	}

	// Atomic write via temp file
	const tmpPath = `${abs}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
	try {
		writeFileSync(tmpPath, finalContent, "utf8")
		renameSync(tmpPath, abs)
	} catch (e) {
		try {
			unlinkSync(tmpPath)
		} catch {}
		throw e
	}

	noteTouched(repo.root, a.path)
	return {
		repo: repo.name,
		branch,
		path: a.path,
		bytes,
		total_edits: a.edits.length,
		edits: editResults,
		eol: crlf ? "crlf" : "lf",
		sha256: createHash("sha256").update(finalContent).digest("hex"),
	}
}

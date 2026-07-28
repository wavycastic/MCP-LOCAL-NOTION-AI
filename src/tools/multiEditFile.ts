import { z } from "zod"
import { MAX_WRITE_BYTES } from "../config.js"
import { atomicWriteText } from "../files/atomicWrite.js"
import { applyReplacements, findTextMatches, type MatchMode } from "../files/matcher.js"
import { readTextSnapshot } from "../files/text.js"
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

type SingleEditResult = {
	index: number
	replacements: number
	match_mode: MatchMode
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
	const snap = readTextSnapshot(abs)

	if (a.expected_sha256) {
		if (snap.sha256 !== a.expected_sha256) {
			throw new Error(
				`expected_sha256 mismatch for ${a.path}. File nay da bi thay doi sau khi doc.`,
			)
		}
	}

	let currentText = snap.text
	const editResults: SingleEditResult[] = []

	for (let i = 0; i < a.edits.length; i++) {
		const edit = a.edits[i]
		const matches = findTextMatches({
			source: currentText,
			needle: edit.old_str,
			maxMatches: edit.replace_all ? undefined : 2,
		})
		const n = matches.length

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

		const selectedMatches = edit.replace_all ? matches : [matches[0]]
		currentText = applyReplacements(currentText, selectedMatches, edit.new_str)

		editResults.push({
			index: i + 1,
			replacements: selectedMatches.length,
			match_mode: matches[0].mode,
		})
	}

	const bytes = Buffer.byteLength(currentText, "utf8")
	if (bytes > MAX_WRITE_BYTES) {
		throw new Error(
			`sau khi multi_edit_file, ${a.path} se nang ${bytes} bytes, vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES}`,
		)
	}

	const writeRes = atomicWriteText({
		abs,
		text: currentText,
		bom: snap.bom,
		eol: snap.eol,
		mode: snap.mode,
	})

	if (writeRes.changed) {
		noteTouched(repo.root, a.path)
	}

	return {
		repo: repo.name,
		branch,
		path: a.path,
		changed: writeRes.changed,
		total_edits: a.edits.length,
		edits: editResults,
		bytes_before: snap.sizeBytes,
		bytes_after: writeRes.bytes_after,
		sha256_before: snap.sha256,
		sha256_after: writeRes.sha256_after,
		eol: snap.eol,
		bom: snap.bom,
	}
}

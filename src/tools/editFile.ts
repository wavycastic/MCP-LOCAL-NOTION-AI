import { z } from "zod"
import { MAX_WRITE_BYTES } from "../config.js"
import { atomicWriteText } from "../files/atomicWrite.js"
import { applyReplacements, findTextMatches, snippetAround } from "../files/matcher.js"
import { readTextSnapshotAsync } from "../files/text.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"
import { safeResolve } from "../security/paths.js"
import { noteTouched } from "../touched.js"

export const editFileSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	path: z.string().describe("Duong dan tuong doi so voi repo root"),
	old_str: z
		.string()
		.describe(
			"Doan text can thay. Phai khop chinh xac ke ca whitespace; rieng kieu xuong dong hoac khoang trang cuoi dong se tu khop",
		),
	new_str: z.string().describe("Doan text thay vao"),
	replace_all: z.boolean().optional().describe("Mac dinh false: bat buoc old_str duy nhat"),
	expected_sha256: z
		.string()
		.optional()
		.describe("Hash sha256 cua noi dung file luc doc. Neu truyen va khong khop, ngung sua de tranh troi troot code"),
}

export async function editFile(a: {
	repo?: string
	path: string
	old_str: string
	new_str: string
	replace_all?: boolean
	expected_sha256?: string
}) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	const abs = safeResolve(repo.root, a.path)
	const snap = await readTextSnapshotAsync(abs)

	if (a.expected_sha256) {
		if (snap.sha256 !== a.expected_sha256) {
			throw new Error(
				`expected_sha256 mismatch for ${a.path}. File nay da bi thay doi sau khi doc.`,
			)
		}
	}

	const matches = findTextMatches({
		source: snap.text,
		needle: a.old_str,
		maxMatches: a.replace_all ? undefined : 2,
	})
	const n = matches.length

	if (n === 0) {
		throw new Error(
			`old_str khong tim thay trong ${a.path}. Doc lai file bang read_file roi copy nguyen van doan can sua`,
		)
	}
	if (n > 1 && !a.replace_all) {
		throw new Error(
			`old_str khop ${n} cho trong ${a.path}. Mo rong old_str cho unique, hoac dat replace_all=true`,
		)
	}

	const selectedMatches = a.replace_all ? matches : [matches[0]]
	const nextText = applyReplacements(snap.text, selectedMatches, a.new_str)

	// Offset match dau tien (nho nhat) giong nhau o text cu lan text moi:
	// applyReplacements splice tu duoi len nen prefix truoc no khong doi. Tra kem
	// context de agent verify ngay, khoi can goi them read_file.
	const context = snippetAround(nextText, selectedMatches[0].start, 5)

	const bytes = Buffer.byteLength(nextText, "utf8")
	if (bytes > MAX_WRITE_BYTES) {
		throw new Error(
			`sau khi sua, ${a.path} se nang ${bytes} bytes, vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES}`,
		)
	}

	const writeRes = atomicWriteText({
		abs,
		text: nextText,
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
		replacements: selectedMatches.length,
		match_mode: matches[0].mode,
		context,
		bytes_before: snap.sizeBytes,
		bytes_after: writeRes.bytes_after,
		sha256_before: snap.sha256,
		sha256_after: writeRes.sha256_after,
		eol: snap.eol,
		bom: snap.bom,
	}
}

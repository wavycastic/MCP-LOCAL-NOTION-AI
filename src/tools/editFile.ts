import { readFileSync, writeFileSync } from "node:fs"
import { z } from "zod"
import { MAX_WRITE_BYTES } from "../config.js"
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
			"Doan text can thay. Phai khop chinh xac ke ca whitespace; rieng kieu xuong dong (CRLF/LF) thi tu khop",
		),
	new_str: z.string().describe("Doan text thay vao"),
	replace_all: z.boolean().optional().describe("Mac dinh false: bat buoc old_str duy nhat"),
}

const toLf = (s: string) => s.replace(/\r\n/g, "\n")
const toCrlf = (s: string) => toLf(s).replace(/\n/g, "\r\n")

/** File dung CRLF khong. Repo Windows (vd .csproj, .axaml) gan nhu luon CRLF. */
function isCrlfFile(raw: string): boolean {
	const crlf = (raw.match(/\r\n/g) ?? []).length
	if (crlf === 0) return false
	const lfTotal = (raw.match(/\n/g) ?? []).length
	return crlf >= lfTotal - crlf
}

/** Thay MOT lan xuat hien dau tien, khong qua String.replace. */
function replaceFirst(parts: string[], oldStr: string, newStr: string): string {
	return parts[0] + newStr + parts.slice(1).join(oldStr)
}

export async function editFile(a: {
	repo?: string
	path: string
	old_str: string
	new_str: string
	replace_all?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	const abs = safeResolve(repo.root, a.path)
	const raw = readFileSync(abs, "utf8")
	const crlf = isCrlfFile(raw)

	/*
	 * Agent hau nhu luon gui old_str voi \n, con file trong repo Windows la \r\n.
	 * Khop tho se truot va bao "old_str khong tim thay" du doan text nhin y het
	 * tren man hinh — loi nay truoc day se xay ra o gan nhu moi file .cs/.axaml.
	 * Vi vay: thu khop tho truoc, khong duoc thi khop lai theo kieu da chuan hoa.
	 */
	let src = raw
	let oldStr = a.old_str
	let newStr = a.new_str
	let eolNormalized = false

	if (!raw.includes(a.old_str)) {
		const lfSrc = toLf(raw)
		const lfOld = toLf(a.old_str)
		if (lfOld.length > 0 && lfSrc.includes(lfOld)) {
			src = lfSrc
			oldStr = lfOld
			newStr = toLf(a.new_str)
			eolNormalized = true
		}
	}

	const parts = src.split(oldStr)
	const n = parts.length - 1
	if (n === 0)
		throw new Error(
			`old_str khong tim thay trong ${a.path}. Doc lai file bang read_file roi copy nguyen van doan can sua`,
		)
	if (n > 1 && !a.replace_all)
		throw new Error(
			`old_str khop ${n} cho trong ${a.path}. Mo rong old_str cho unique, hoac dat replace_all=true`,
		)

	/*
	 * Truoc day nhanh mot-lan dung src.replace(oldStr, newStr). String.replace hieu
	 * $&, $1, $` trong CHUOI THAY THE la ky hieu dac biet, nen new_str chua nhung
	 * ky tu do se bi bien dang am tham. split/join khong dien giai gi.
	 */
	let next = a.replace_all ? parts.join(newStr) : replaceFirst(parts, oldStr, newStr)

	// Giu nguyen kieu xuong dong cua file: khong bien ca file thanh LF chi vi sua 1 dong
	// (diff se phinh ra toan bo file), va khong de lai file lai xen CRLF/LF.
	if (crlf) next = toCrlf(next)

	// Cung tran nhu create_file: truoc day edit_file khong kiem gi, nen cua truoc
	// khoa ma cua sau mo — new_str dai bao nhieu cung ghi.
	const bytes = Buffer.byteLength(next, "utf8")
	if (bytes > MAX_WRITE_BYTES)
		throw new Error(
			`sau khi sua, ${a.path} se nang ${bytes} bytes, vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES}`,
		)

	writeFileSync(abs, next, "utf8")
	noteTouched(repo.root, a.path)
	return {
		repo: repo.name,
		branch,
		path: a.path,
		bytes,
		replacements: a.replace_all ? n : 1,
		eol: crlf ? "crlf" : "lf",
		...(eolNormalized ? { note: "old_str khop sau khi bo qua khac biet CRLF/LF" } : {}),
	}
}

import { readFileSync, writeFileSync } from "node:fs"
import { z } from "zod"
import { assertWritableBranch } from "../git.js"
import { safeResolve } from "../security/paths.js"

export const editFileSchema = {
	path: z.string().describe("Duong dan tuong doi so voi repo root"),
	old_str: z.string().describe("Doan text can thay. Phai khop CHINH XAC, ke ca whitespace"),
	new_str: z.string().describe("Doan text thay vao"),
	replace_all: z.boolean().optional().describe("Mac dinh false: bat buoc old_str duy nhat"),
}

export async function editFile(a: {
	path: string
	old_str: string
	new_str: string
	replace_all?: boolean
}) {
	await assertWritableBranch()
	const abs = safeResolve(a.path)
	const src = readFileSync(abs, "utf8")

	const parts = src.split(a.old_str)
	const n = parts.length - 1
	if (n === 0) throw new Error(`old_str khong tim thay trong ${a.path}`)
	if (n > 1 && !a.replace_all)
		throw new Error(
			`old_str khop ${n} cho trong ${a.path}. Mo rong old_str cho unique, hoac dat replace_all=true`,
		)

	const next = a.replace_all
		? parts.join(a.new_str)
		: src.replace(a.old_str, a.new_str)
	writeFileSync(abs, next, "utf8")
	return { path: a.path, replacements: a.replace_all ? n : 1 }
}

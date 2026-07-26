import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { MAX_WRITE_BYTES } from "../config.js"
import { assertWritableBranch } from "../git.js"
import { resolveRepo } from "../repos.js"
import { safeResolveNew } from "../security/paths.js"
import { noteTouched } from "../touched.js"

export const createFileSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	path: z.string().describe("Duong dan tuong doi so voi repo root. Thu muc cha se duoc tao neu thieu"),
	content: z.string().describe("Noi dung file day du"),
}

/**
 * Chi TAO FILE MOI. Khong ghi de file da ton tai — do la chu y:
 * muon sua file cu thi phai doc roi dung edit_file.
 */
export async function createFile(a: { repo?: string; path: string; content: string }) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)
	const abs = safeResolveNew(repo.root, a.path)

	if (existsSync(abs))
		throw new Error(
			`${a.path} da ton tai. Dung read_file roi edit_file de sua, khong ghi de ca file`,
		)

	const bytes = Buffer.byteLength(a.content, "utf8")
	if (bytes > MAX_WRITE_BYTES)
		throw new Error(`content ${bytes} bytes, vuot MAX_WRITE_BYTES=${MAX_WRITE_BYTES}`)

	mkdirSync(dirname(abs), { recursive: true })
	writeFileSync(abs, a.content, "utf8")
	noteTouched(repo.root, a.path)
	return { repo: repo.name, branch, path: a.path, bytes, created: true }
}

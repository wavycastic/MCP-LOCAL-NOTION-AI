import { z } from "zod"
import { run } from "../exec.js"
import { assertWritableBranch } from "../git.js"
import { startJob } from "../jobs.js"
import { resolveRepo } from "../repos.js"
import { isDeniedRelPath } from "../security/paths.js"
import { clearTouched, peekTouched } from "../touched.js"

export const gitCommitSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Repo phai duoc cap quyen ghi"),
	message: z.string().min(3).max(2000),
	all: z
		.boolean()
		.optional()
		.describe(
			"true: stage MOI thay doi trong repo, ke ca thay doi nguoi dung tu sua. Mac dinh false: chi stage nhung file cac tool nay da sua",
		),
	reindex: z
		.boolean()
		.optional()
		.describe(
			"Mac dinh true: sau khi commit tu chay lai index code graph o background de graph khong bi cu",
		),
}

export async function gitCommit(a: {
	repo?: string
	message: string
	all?: boolean
	reindex?: boolean
}) {
	const repo = resolveRepo(a.repo)
	const branch = await assertWritableBranch(repo)

	const touched = peekTouched(repo.root)

	if (a.all) {
		await run(["git", "add", "-A"], { cwd: repo.root, timeoutMs: 60_000 })
	} else {
		if (touched.length === 0)
			throw new Error(
				`khong co file nao do cac tool nay sua trong repo "${repo.name}". ` +
					`Neu that su muon commit ca thay doi ban tu sua tay thi dat all=true`,
			)
		// -A kem pathspec: stage ca file bi xoa, va chi trong pham vi cac path do.
		await run(["git", "add", "-A", "--", ...touched], {
			cwd: repo.root,
			timeoutMs: 60_000,
		})
	}

	// Deny-list phai chan ca duong RA. Chi chan doc thi chua du: `git add -A` rat de
	// keo .env hay key vao commit roi day len remote.
	const staged = await run(["git", "diff", "--cached", "--name-only"], {
		cwd: repo.root,
		timeoutMs: 30_000,
	})
	const denied = staged.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.filter(isDeniedRelPath)

	if (denied.length > 0) {
		// reset theo path: chi bo stage, KHONG doi working tree (khong --hard).
		await run(["git", "reset", "--", ...denied], { cwd: repo.root, timeoutMs: 30_000 })
		throw new Error(
			`tu choi commit: ${denied.length} file thuoc deny-list dang cho commit (${denied.join(", ")}). ` +
				`Da bo stage. Them chung vao .gitignore hoac di chuyen ra ngoai repo roi thu lai`,
		)
	}

	// spawn khong qua shell nen truyen -m truc tiep la an toan.
	const r = await run(["git", "commit", "-m", a.message], {
		cwd: repo.root,
		timeoutMs: 60_000,
	})
	if (r.code !== 0)
		throw new Error(
			`git commit that bai (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
		)

	clearTouched(repo.root)

	const sha = await run(["git", "rev-parse", "--short", "HEAD"], {
		cwd: repo.root,
		timeoutMs: 15_000,
	})

	// Code vua doi thi code graph thanh lac hau ngay lap tuc. Neu de agent tu nho
	// goi reindex thi se co luc no quen, va lan query sau tra ve du lieu cu ma
	// khong co dau hieu gi. Chay ngay o background.
	const job = a.reindex === false ? undefined : startJob(repo.name, repo.root, [...repo.reindex])

	return {
		repo: repo.name,
		branch,
		sha: sha.stdout.trim(),
		exit_code: r.code,
		committed: a.all ? "tat ca thay doi trong repo" : touched,
		...(job ? { reindex_job: job.id } : {}),
		output: r.stdout + r.stderr,
	}
}

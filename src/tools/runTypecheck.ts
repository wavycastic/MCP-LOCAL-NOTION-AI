import { z } from "zod"
import { SYNC_WAIT_MS } from "../config.js"
import { startJob, waitForJob, type Job } from "../jobs.js"
import { resolveRepo, type Repo } from "../repos.js"

export const runTypecheckSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	background: z
		.boolean()
		.optional()
		.describe("true: tra ve job_id ngay, hoi ket qua bang job_status"),
}

function queued(repoName: string, job: Job, waited: boolean) {
	return {
		repo: repoName,
		job_id: job.id,
		status: job.status,
		command: job.command,
		hint: waited
			? `chua xong sau ${Math.round(SYNC_WAIT_MS / 1000)}s nen chuyen sang background — goi job_status voi job_id "${job.id}" de lay ket qua`
			: `dang chay o background — goi job_status voi job_id "${job.id}" de lay ket qua`,
	}
}

function finished(repoName: string, job: Job) {
	return {
		repo: repoName,
		job_id: job.id,
		command: job.command,
		exit_code: job.exit_code ?? null,
		timed_out: job.timed_out ?? false,
		output: job.output ?? job.error ?? "",
	}
}

async function runOrQueue(repo: Repo, argv: string[], wantBackground?: boolean) {
	const job = startJob(repo.name, repo.root, argv)
	if (wantBackground) return queued(repo.name, job, false)

	const done = await waitForJob(job.id, SYNC_WAIT_MS)
	return done ? finished(repo.name, done) : queued(repo.name, job, true)
}

export async function runTypecheck(a: { repo?: string; background?: boolean }) {
	const repo = resolveRepo(a.repo)
	if (!repo.typecheck) {
		throw new Error(
			`repo "${repo.name}" (toolchain: ${repo.toolchain}) khong co lenh typecheck. Khai bao "typecheck": [...] cho no trong repos.json`,
		)
	}

	return runOrQueue(repo, [...repo.typecheck], a.background)
}

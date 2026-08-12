import { z } from "zod"
import { cancelJob, getJob, isJobFinished } from "../jobs.js"
import { resolveRepo } from "../repos.js"

export const killJobSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	job_id: z.string().min(1).describe("ID cua job can dung (vd: job-1)"),
}

export async function killJob(a: { repo?: string; job_id: string }) {
	const job = getJob(a.job_id)
	if (!job) {
		throw new Error(`khong biet job_id "${a.job_id}"`)
	}

	if (a.repo) {
		// Chan kill cheo: job phai thuoc repo duoc chi dinh.
		const repo = resolveRepo(a.repo)
		if (job.repo !== repo.name) {
			throw new Error(`job "${a.job_id}" thuoc repo "${job.repo}", khong phai "${repo.name}"`)
		}
	}

	if (isJobFinished(job)) {
		return {
			repo: job.repo,
			job_id: job.id,
			already_finished: true,
			status: job.status,
		}
	}

	const killed = cancelJob(a.job_id)
	return {
		repo: job.repo,
		job_id: job.id,
		killed,
		status: "failed",
		message: `da dung job "${job.id}" (${job.command})`,
	}
}

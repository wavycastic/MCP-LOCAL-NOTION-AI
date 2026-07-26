import { z } from "zod"
import { getJob, listJobs } from "../jobs.js"

export const jobStatusSchema = {
	job_id: z.string().optional().describe("Bo trong de liet ke cac job gan day"),
	repo: z.string().optional().describe("Chi liet ke job cua repo nay"),
	tail_lines: z.number().int().min(1).max(2000).optional().describe("Mac dinh 200 dong cuoi"),
}

function tailOf(output: string | undefined, n: number): string | undefined {
	if (output === undefined) return undefined
	const lines = output.split("\n")
	return lines.slice(-n).join("\n")
}

/** Hoi ket qua cua job do run_build/run_tests tao ra khi background=true. */
export async function jobStatus(a: { job_id?: string; repo?: string; tail_lines?: number }) {
	if (!a.job_id) {
		return {
			jobs: listJobs(a.repo).map((j) => ({
				id: j.id,
				repo: j.repo,
				command: j.command,
				status: j.status,
				started_at: j.started_at,
				ended_at: j.ended_at,
				exit_code: j.exit_code,
			})),
		}
	}

	const job = getJob(a.job_id)
	if (!job)
		throw new Error(
			`khong biet job "${a.job_id}" (co the da bi don sau 50 job). Goi job_status khong kem job_id de xem danh sach`,
		)

	return {
		...job,
		output: tailOf(job.output, a.tail_lines ?? 200),
		done: job.status === "done" || job.status === "failed",
	}
}

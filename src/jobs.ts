import { run } from "./exec.js"
import { withLock } from "./lock.js"

export type JobStatus = "queued" | "running" | "done" | "failed"

export type Job = {
	id: string
	repo: string
	command: string
	status: JobStatus
	started_at: string
	ended_at?: string
	exit_code?: number | null
	timed_out?: boolean
	output?: string
	error?: string
}

const jobs = new Map<string, Job>()
const MAX_JOBS = 50
let seq = 0

function isFinished(j: Job): boolean {
	return j.status === "done" || j.status === "failed"
}

/**
 * Chi don job DA KET THUC, cu nhat truoc (Map giu thu tu chen).
 *
 * Truoc day xoa thang key dau tien bat ke status: mot build dai co the bi xoa khoi
 * bang trong khi tien trinh van chay, roi job_status tra "khong biet job" — agent
 * tuong build bay hoi. Neu tat ca 50 job dang chay thi cu de vuot han, chung se
 * ket thuc va bi don o lan sau.
 */
function prune() {
	if (jobs.size <= MAX_JOBS) return
	for (const [id, j] of jobs) {
		if (jobs.size <= MAX_JOBS) return
		if (isFinished(j)) jobs.delete(id)
	}
}

/**
 * Chay lenh dai (build/test/reindex) ma tra ve ngay, de mot HTTP request khong
 * phai giu nguyen 5-10 phut — tunnel hoac client rat de ngat truoc khi xong.
 *
 * Job VAN chay trong mutex cua repo: mot edit_file goi sau se xep hang cho build
 * xong, dung nhu khi chay dong bo. Khong duoc bo lock chi vi doi sang bat dong bo.
 *
 * waitMs = 0: job xep hang vo han. Chinh no la viec dai, khong the tu bo cuoc vi
 * cho lau nhu mot tool tuong tac.
 */
export function startJob(
	repoName: string,
	cwd: string,
	argv: string[],
	timeoutMs?: number,
): Job {
	const id = `job-${++seq}`
	const job: Job = {
		id,
		repo: repoName,
		command: argv.join(" "),
		status: "queued",
		started_at: new Date().toISOString(),
	}
	jobs.set(id, job)
	prune()

	void withLock(
		cwd,
		`job:${id}`,
		async () => {
			job.status = "running"
			try {
				const r = await run(argv, { cwd, timeoutMs })
				job.exit_code = r.code
				job.timed_out = r.timedOut
				job.output = (r.stdout + "\n" + r.stderr).slice(-60_000)
				job.status = r.code === 0 ? "done" : "failed"
			} catch (e) {
				job.status = "failed"
				job.error = e instanceof Error ? e.message : String(e)
			} finally {
				job.ended_at = new Date().toISOString()
			}
		},
		0,
	)

	return job
}

export function getJob(id: string): Job | undefined {
	return jobs.get(id)
}

export function listJobs(repoName?: string): Job[] {
	const all = [...jobs.values()]
	return repoName ? all.filter((j) => j.repo === repoName) : all
}

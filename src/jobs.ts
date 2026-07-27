import type { ChildProcess } from "node:child_process"
import { killTree, run } from "./exec.js"
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

/** Job + nhung thu chi ben trong module nay can biet. */
type Rec = {
	job: Job
	/** Co gia tri tu luc spawn den luc ket thuc — duong duy nhat de giet giua duong. */
	child?: ChildProcess
	/** Resolve khi job ket thuc (ke ca that bai). Khong bao gio reject. */
	done: Promise<void>
}

const jobs = new Map<string, Rec>()
const MAX_JOBS = 50
let seq = 0

export function isJobFinished(j: Job): boolean {
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
	for (const [id, rec] of jobs) {
		if (jobs.size <= MAX_JOBS) return
		if (isJobFinished(rec.job)) jobs.delete(id)
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
	extraEnv?: Record<string, string>,
): Job {
	const id = `job-${++seq}`
	const job: Job = {
		id,
		repo: repoName,
		command: argv.join(" "),
		status: "queued",
		started_at: new Date().toISOString(),
	}

	const rec: Rec = { job, done: Promise.resolve() }
	jobs.set(id, rec)
	prune()

	rec.done = withLock(
		cwd,
		`job:${id}`,
		async () => {
			job.status = "running"
			try {
				const r = await run(argv, {
					cwd,
					timeoutMs,
					env: extraEnv,
					onSpawn: (p) => {
						rec.child = p
					},
				})
				job.exit_code = r.code
				job.timed_out = r.timedOut
				job.output = (r.stdout + "\n" + r.stderr).slice(-60_000)
				job.status = r.code === 0 ? "done" : "failed"
			} catch (e) {
				job.status = "failed"
				job.error = e instanceof Error ? e.message : String(e)
			} finally {
				rec.child = undefined
				job.ended_at = new Date().toISOString()
			}
		},
		0,
	).then(
		() => undefined,
		// Loi cua lock (khong phai cua lenh) cung phai lam job ket thuc, khong thi
		// nguoi cho se cho vinh vien.
		(e: unknown) => {
			if (!isJobFinished(job)) {
				job.status = "failed"
				job.error = e instanceof Error ? e.message : String(e)
				job.ended_at = new Date().toISOString()
			}
		},
	)

	return job
}

/**
 * Cho job xong toi da ms. Tra ve job neu da ket thuc, undefined neu con chay.
 *
 * Dung cho run_build/run_tests kieu dong bo: viec ngan thi tra ket qua ngay trong
 * cung mot lan goi tool, viec dai thi tu dong lui ve background thay vi giu HTTP
 * request treo cho den luc client ngat.
 */
export async function waitForJob(id: string, ms: number): Promise<Job | undefined> {
	const rec = jobs.get(id)
	if (!rec) return undefined
	if (isJobFinished(rec.job)) return rec.job

	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<void>((res) => {
		timer = setTimeout(res, ms)
	})
	try {
		await Promise.race([rec.done, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
	return isJobFinished(rec.job) ? rec.job : undefined
}

/**
 * Giet moi job chua ket thuc. Goi luc tat server: khong lam viec nay thi
 * `dotnet build` hay `npx gitnexus analyze` van chay tiep sau khi server chet,
 * khoa file trong repo va khong con ai theo doi duoc no.
 */
export function killRunningJobs(): number {
	let killed = 0
	for (const rec of jobs.values()) {
		if (isJobFinished(rec.job)) continue
		if (rec.child) {
			killTree(rec.child)
			killed++
		}
		rec.job.status = "failed"
		rec.job.error = "server dang tat nen job bi huy"
		rec.job.ended_at = new Date().toISOString()
	}
	return killed
}

export function getJob(id: string): Job | undefined {
	return jobs.get(id)?.job
}

export function cancelJob(id: string): boolean {
	const rec = jobs.get(id)
	if (!rec || isJobFinished(rec.job)) return false
	if (rec.child) {
		killTree(rec.child)
	}
	rec.job.status = "failed"
	rec.job.error = "job bi huy boi kill_job tool"
	rec.job.ended_at = new Date().toISOString()
	return true
}

export function listJobs(repoName?: string): Job[] {
	const all = [...jobs.values()].map((r) => r.job)
	return repoName ? all.filter((j) => j.repo === repoName) : all
}

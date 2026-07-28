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

type Rec = {
	job: Job
	child?: ChildProcess
	done: Promise<void>
}

const jobs = new Map<string, Rec>()
const MAX_JOBS = 50
let seq = 0

export function isJobFinished(j: Job): boolean {
	return j.status === "done" || j.status === "failed"
}

function prune() {
	if (jobs.size <= MAX_JOBS) return
	for (const [id, rec] of jobs) {
		if (jobs.size <= MAX_JOBS) return
		if (isJobFinished(rec.job)) jobs.delete(id)
	}
}

/**
 * Chay lenh dai (build/test/reindex/terminal) va hold exclusive repo lock lease
 * cho den khi process hoan tat (hoac bi cancelJob / kill_job).
 */
export function startJob(
	repoName: string,
	lockKey: string,
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
		lockKey,
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

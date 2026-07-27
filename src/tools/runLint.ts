import { z } from "zod"
import { SYNC_WAIT_MS } from "../config.js"
import { startJob, waitForJob, type Job } from "../jobs.js"
import { resolveRepo, type Repo } from "../repos.js"

export const runLintSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	fix: z.boolean().optional().describe("true: tu dong sua cac loi format/style neu toolchain ho tro"),
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

export async function runLint(a: { repo?: string; fix?: boolean; background?: boolean }) {
	const repo = resolveRepo(a.repo)
	if (!repo.lint) {
		throw new Error(
			`repo "${repo.name}" (toolchain: ${repo.toolchain}) khong co lenh lint. Khai bao "lint": [...] cho no trong repos.json`,
		)
	}

	const argv = [...repo.lint]
	if (a.fix) {
		if (repo.toolchain === "dotnet") {
			const idx = argv.indexOf("--verify-no-changes")
			if (idx !== -1) argv.splice(idx, 1)
		} else if (repo.toolchain === "npm" || repo.toolchain === "python") {
			argv.push("--fix")
		} else if (repo.toolchain === "cargo") {
			argv.push("--fix", "--allow-no-vcs")
		}
	}

	return runOrQueue(repo, argv, a.background)
}

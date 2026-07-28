import { z } from "zod"
import { SYNC_WAIT_MS } from "../config.js"
import { startJob, waitForJob, type Job } from "../jobs.js"
import { resolveRepo, type Repo } from "../repos.js"

const background = z
	.boolean()
	.optional()
	.describe(
		"true: tra ve job_id ngay, hoi ket qua bang job_status. Neu bo trong: cho toi 60s roi tu chuyen sang background",
	)

// Chi nhan --filter (chi ap dung cho toolchain ho tro), khong nhan argv tuy y.
export const runTestsSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	filter: z
		.string()
		.regex(/^[A-Za-z0-9_.~=|!&()\-]+$/, "filter chua ky tu khong cho phep")
		.optional()
		.describe("Truyen vao --filter cua test runner (dotnet). Bo qua neu toolchain khong ho tro"),
	background,
}

export const runBuildSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	background,
}

function queued(repoName: string, job: Job, waited: boolean) {
	return {
		repo: repoName,
		job_id: job.id,
		status: job.status,
		command: job.command,
		hint: waited
			? `chua xong sau ${Math.round(SYNC_WAIT_MS / 1000)}s nen chuyen sang background — ` +
				`goi job_status voi job_id "${job.id}" de lay ket qua`
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

/**
 * Moi lenh build/test deu di qua job, ke ca khi nguoi goi muon cho ket qua ngay.
 *
 * Hai ly do:
 * 1. Truoc day nhanh dong bo goi run() truc tiep voi han 15 phut. Client MCP va
 *    tunnel ngat truoc do rat lau, nen mot ban build that su cua CV-AUT gan nhu
 *    chac chan tra ve loi mang — va tien trinh dotnet thi van chay tiep, khong ai
 *    con doi duoc ket qua. Gio cho toi SYNC_WAIT_MS roi tra job_id: viec ngan van
 *    xong trong mot lan goi, viec dai khong con mat dau.
 * 2. Nhanh dong bo cu KHONG lay lock cua repo, nen mot build co the chay song song
 *    voi edit_file cua chinh no — dung thu tu ma job (bat dong bo) da lo tranh.
 */
async function runOrQueue(repo: Repo, argv: string[], wantBackground?: boolean) {
	const job = startJob(repo.name, repo.root, repo.root, argv)
	if (wantBackground) return queued(repo.name, job, false)

	const done = await waitForJob(job.id, SYNC_WAIT_MS)
	return done ? finished(repo.name, done) : queued(repo.name, job, true)
}

export async function runTests(a: { repo?: string; filter?: string; background?: boolean }) {
	const repo = resolveRepo(a.repo)
	if (!repo.test)
		throw new Error(
			`repo "${repo.name}" (toolchain: ${repo.toolchain}) khong co lenh test. Khai bao "test": [...] cho no trong repos.json`,
		)

	const argv = [...repo.test]
	if (a.filter) {
		if (repo.toolchain !== "dotnet")
			throw new Error(`filter chi ho tro toolchain dotnet, repo nay la ${repo.toolchain}`)
		argv.push("--filter", a.filter)
	}

	return runOrQueue(repo, argv, a.background)
}

export async function runBuild(a: { repo?: string; background?: boolean }) {
	const repo = resolveRepo(a.repo)
	if (!repo.build)
		throw new Error(
			`repo "${repo.name}" (toolchain: ${repo.toolchain}) khong co lenh build. Khai bao "build": [...] cho no trong repos.json`,
		)

	return runOrQueue(repo, [...repo.build], a.background)
}

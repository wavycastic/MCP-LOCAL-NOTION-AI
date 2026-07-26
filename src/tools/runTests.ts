import { z } from "zod"
import { run } from "../exec.js"
import { startJob } from "../jobs.js"
import { resolveRepo } from "../repos.js"

const background = z
	.boolean()
	.optional()
	.describe(
		"true: tra ve job_id ngay, hoi ket qua bang job_status. Dung cho repo lon (build > 1 phut)",
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

function tail(r: { stdout: string; stderr: string }) {
	return (r.stdout + "\n" + r.stderr).slice(-60_000) // duoi log la cho co loi
}

function queued(repoName: string, job: { id: string; status: string; command: string }) {
	return {
		repo: repoName,
		job_id: job.id,
		status: job.status,
		command: job.command,
		hint: `dang chay o background — goi job_status voi job_id "${job.id}" de lay ket qua`,
	}
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

	if (a.background) return queued(repo.name, startJob(repo.name, repo.root, argv))

	const r = await run(argv, { cwd: repo.root })
	return {
		repo: repo.name,
		command: argv.join(" "),
		exit_code: r.code,
		timed_out: r.timedOut,
		output: tail(r),
	}
}

export async function runBuild(a: { repo?: string; background?: boolean }) {
	const repo = resolveRepo(a.repo)
	if (!repo.build)
		throw new Error(
			`repo "${repo.name}" (toolchain: ${repo.toolchain}) khong co lenh build. Khai bao "build": [...] cho no trong repos.json`,
		)

	if (a.background) return queued(repo.name, startJob(repo.name, repo.root, [...repo.build]))

	const r = await run([...repo.build], { cwd: repo.root })
	return {
		repo: repo.name,
		command: repo.build.join(" "),
		exit_code: r.code,
		timed_out: r.timedOut,
		output: tail(r),
	}
}

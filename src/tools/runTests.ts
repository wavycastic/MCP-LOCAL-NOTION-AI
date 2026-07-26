import { z } from "zod"
import { run } from "../exec.js"
import { resolveRepo } from "../repos.js"

// Chi nhan --filter (chi ap dung cho toolchain ho tro), khong nhan argv tuy y.
export const runTestsSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	filter: z
		.string()
		.regex(/^[A-Za-z0-9_.~=|!&()\-]+$/, "filter chua ky tu khong cho phep")
		.optional()
		.describe("Truyen vao --filter cua test runner (dotnet). Bo qua neu toolchain khong ho tro"),
}

export const runBuildSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
}

function tail(r: { stdout: string; stderr: string }) {
	return (r.stdout + "\n" + r.stderr).slice(-60_000) // duoi log la cho co loi
}

export async function runTests(a: { repo?: string; filter?: string }) {
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
	const r = await run(argv, { cwd: repo.root })
	return {
		repo: repo.name,
		command: argv.join(" "),
		exit_code: r.code,
		timed_out: r.timedOut,
		output: tail(r),
	}
}

export async function runBuild(a: { repo?: string }) {
	const repo = resolveRepo(a.repo)
	if (!repo.build)
		throw new Error(
			`repo "${repo.name}" (toolchain: ${repo.toolchain}) khong co lenh build. Khai bao "build": [...] cho no trong repos.json`,
		)

	const r = await run([...repo.build], { cwd: repo.root })
	return {
		repo: repo.name,
		command: repo.build.join(" "),
		exit_code: r.code,
		timed_out: r.timedOut,
		output: tail(r),
	}
}

import { z } from "zod"
import { ALLOW_TERMINAL, SYNC_WAIT_MS, TERMINAL_INHERIT_SECRETS, TERMINAL_MAX_COMMAND_CHARS, TERMINAL_MODE } from "../config.js"
import { buildTerminalEnv } from "../exec.js"
import { startJob, waitForJob, type Job } from "../jobs.js"
import { resolveRepo } from "../repos.js"
import { safeResolveDir } from "../security/paths.js"

export const terminalSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Bo trong neu chi co 1 repo"),
	command: z.string().min(1).describe("Lenh terminal can chay, se duoc thuc thi qua shell cua OS"),
	dir: z
		.string()
		.optional()
		.describe("Thu muc con tuong doi trong repo de chay lenh (mac dinh: repo root)"),
	shell: z
		.enum(["cmd", "powershell", "pwsh", "bash", "sh"])
		.optional()
		.describe("Loai shell de thuc thi (cmd, powershell, pwsh, bash, sh)"),
	env: z
		.record(z.string())
		.optional()
		.describe("Cac bien moi truong ghi de (Key-Value) khi chay lenh"),
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
		command_length: job.command.length,
		hint: waited
			? `chua xong sau ${Math.round(SYNC_WAIT_MS / 1000)}s nen chuyen sang background — goi job_status voi job_id "${job.id}" de lay ket qua`
			: `dang chay o background — goi job_status voi job_id "${job.id}" de lay ket qua`,
	}
}

function finished(repoName: string, job: Job) {
	return {
		repo: repoName,
		job_id: job.id,
		command_length: job.command.length,
		exit_code: job.exit_code ?? null,
		timed_out: job.timed_out ?? false,
		output: job.output ?? job.error ?? "",
	}
}

function buildShellArgv(cmdStr: string, chosenShell?: string): string[] {
	if (chosenShell) {
		switch (chosenShell) {
			case "cmd":
				return ["cmd", "/c", cmdStr]
			case "powershell":
				return ["powershell", "-NoProfile", "-Command", cmdStr]
			case "pwsh":
				return ["pwsh", "-NoProfile", "-Command", cmdStr]
			case "bash":
				return ["bash", "-c", cmdStr]
			case "sh":
				return ["sh", "-c", cmdStr]
		}
	}
	if (process.platform === "win32") {
		return ["cmd", "/c", cmdStr]
	}
	return ["sh", "-c", cmdStr]
}

export async function terminal(a: {
	repo?: string
	command: string
	dir?: string
	shell?: "cmd" | "powershell" | "pwsh" | "bash" | "sh"
	env?: Record<string, string>
	background?: boolean
}) {
	if (!ALLOW_TERMINAL || TERMINAL_MODE === "disabled") {
		throw new Error(
			`terminal tool dang tat. Dat ALLOW_TERMINAL=true trong env neu that su muon cho agent chay shell lenh truc tiep`,
		)
	}

	if (a.command.length > TERMINAL_MAX_COMMAND_CHARS) {
		throw new Error(
			`Do dai command (${a.command.length} chars) vuot TERMINAL_MAX_COMMAND_CHARS=${TERMINAL_MAX_COMMAND_CHARS}`,
		)
	}

	const repo = resolveRepo(a.repo)
	const cwd = safeResolveDir(repo.root, a.dir)
	const argv = buildShellArgv(a.command, a.shell)
	const sanitizedEnv = buildTerminalEnv(a.env, TERMINAL_INHERIT_SECRETS)

	const job = startJob(repo.name, cwd, argv, undefined, sanitizedEnv)
	if (a.background) return queued(repo.name, job, false)

	const done = await waitForJob(job.id, SYNC_WAIT_MS)
	return done ? finished(repo.name, done) : queued(repo.name, job, true)
}

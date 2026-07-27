import { z } from "zod"
import { run } from "../exec.js"
import { resolveRepo } from "../repos.js"

export const ghPrSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	action: z
		.enum(["status", "list", "view", "create"])
		.default("status")
		.describe("Thao tac voi GitHub Pull Request qua GitHub CLI (gh)"),
	title: z.string().optional().describe("Tieu de PR (khi action=create)"),
	body: z.string().optional().describe("Noi dung mo ta PR (khi action=create)"),
	draft: z.boolean().optional().describe("true: tao PR duoi dạng draft (khi action=create)"),
	pr: z.string().optional().describe("So hoac URL cua PR (khi action=view)"),
}

export async function ghPr(a: {
	repo?: string
	action: "status" | "list" | "view" | "create"
	title?: string
	body?: string
	draft?: boolean
	pr?: string
}) {
	const repo = resolveRepo(a.repo)

	// Check if `gh` CLI is available
	try {
		const check = await run(["gh", "--version"], { cwd: repo.root, timeoutMs: 5_000 })
		if (check.code !== 0) {
			throw new Error("gh CLI khong phan hoi")
		}
	} catch (e) {
		throw new Error(
			`GitHub CLI (gh) chua duoc cai dat hoac khong nam trong PATH. ` +
				`Cai dat gh CLI tu https://cli.github.com va dang nhap bang "gh auth login" de dung tool nay.`,
		)
	}

	if (a.action === "status") {
		const r = await run(["gh", "pr", "status"], { cwd: repo.root, timeoutMs: 30_000 })
		return {
			repo: repo.name,
			action: "status",
			exit_code: r.code,
			output: r.stdout.trim() || r.stderr.trim(),
		}
	}

	if (a.action === "list") {
		const r = await run(["gh", "pr", "list"], { cwd: repo.root, timeoutMs: 30_000 })
		return {
			repo: repo.name,
			action: "list",
			exit_code: r.code,
			output: r.stdout.trim() || r.stderr.trim(),
		}
	}

	if (a.action === "view") {
		const argv = a.pr ? ["gh", "pr", "view", a.pr] : ["gh", "pr", "view"]
		const r = await run(argv, { cwd: repo.root, timeoutMs: 30_000 })
		return {
			repo: repo.name,
			action: "view",
			exit_code: r.code,
			output: r.stdout.trim() || r.stderr.trim(),
		}
	}

	if (a.action === "create") {
		const argv = ["gh", "pr", "create"]
		if (a.title) argv.push("--title", a.title)
		if (a.body) argv.push("--body", a.body)
		if (a.draft) argv.push("--draft")

		const r = await run(argv, { cwd: repo.root, timeoutMs: 45_000 })
		if (r.code !== 0) {
			throw new Error(`gh pr create that bai (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
		}
		return {
			repo: repo.name,
			action: "create",
			exit_code: r.code,
			output: r.stdout.trim() || r.stderr.trim(),
		}
	}

	throw new Error(`action "${a.action}" khong hop le`)
}

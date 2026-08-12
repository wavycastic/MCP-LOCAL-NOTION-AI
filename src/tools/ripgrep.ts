import { z } from "zod"
import { run } from "../exec.js"
import { mapLimit } from "../files/concurrency.js"
import { allRepos, resolveRepo, type Repo } from "../repos.js"

export const ripgrepSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos). Bo qua khi all_repos=true"),
	all_repos: z
		.boolean()
		.optional()
		.describe(
			'Tim trong TAT CA repo dang phuc vu. Dung cho cau hoi "con cho nao con dung X" truoc khi doi/xoa mot symbol',
		),
	pattern: z.string(),
	glob: z.string().optional().describe("vd: *.cs, *.axaml, *.ts"),
	ignore_case: z.boolean().optional(),
	max_count: z.number().int().min(1).max(500).optional(),
}

type Args = {
	repo?: string
	all_repos?: boolean
	pattern: string
	glob?: string
	ignore_case?: boolean
	max_count?: number
}

const MAX_REPOS = 20
const MAX_CHARS_PER_REPO = 40_000

/**
 * Deny-list o dang glob. Moi tool doc file deu di qua security/paths.ts, nhung
 * grep khong nhan path — no quet ca cay. Thieu doan nay thi
 * `{ glob: "*.pem", pattern: "." }` in ra thang noi dung private key, tuc la
 * duong vong qua toan bo deny-list.
 *
 * rg: glob sau ghi de glob truoc, nen phai day xuong SAU glob cua nguoi goi.
 */
export const DENY_GLOBS = [
	"!**/.env",
	"!**/.env.*",
	"!**/*.pem",
	"!**/*.key",
	"!**/*.pfx",
	"!**/*.p12",
	"!**/*.jks",
	"!**/secret/**",
	"!**/secrets/**",
	"!**/id_rsa*",
	"!**/id_dsa*",
	"!**/id_ecdsa*",
	"!**/id_ed25519*",
	"!**/.npmrc",
	"!**/.git/config",
	"!**/.git/credentials",
]

/** Cung deny-list nhung theo cu phap pathspec cua git, dung cho nhanh git grep. */
export const DENY_PATHSPECS = DENY_GLOBS.map((g) => `:(exclude)${g.slice(1)}`)

type Hit = {
	repo: string
	engine: "ripgrep" | "git-grep"
	matches: string
	truncated: boolean
	note?: string
}

function hit(repo: Repo, engine: Hit["engine"], stdout: string, note?: string): Hit {
	return {
		repo: repo.name,
		engine,
		matches: stdout.slice(0, MAX_CHARS_PER_REPO),
		truncated: stdout.length > MAX_CHARS_PER_REPO,
		...(note ? { note } : {}),
	}
}

/**
 * rg khong co san tren moi may. Truoc day loi hien ra la "ENOENT" tran trui va
 * agent khong biet lam gi; gio lui ve `git grep` (chi tim file da track) va noi
 * ro trong ket qua.
 */
async function grepOne(repo: Repo, a: Args): Promise<Hit> {
	const rg = ["rg", "--line-number", "--no-heading", "--color", "never"]
	if (a.ignore_case) rg.push("-i")
	if (a.glob) rg.push("--glob", a.glob)
	for (const g of DENY_GLOBS) rg.push("--glob", g)
	rg.push("--max-count", String(a.max_count ?? 100))
	rg.push("--regexp", a.pattern) // --regexp: pattern khong bi hieu thanh flag
	rg.push(".")

	try {
		const r = await run(rg, { cwd: repo.root, timeoutMs: 60_000 })
		return hit(repo, "ripgrep", r.stdout)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (!msg.includes("ENOENT")) throw e

		const gg = ["git", "grep", "--line-number", "--no-color"]
		if (a.ignore_case) gg.push("-i")
		gg.push("-e", a.pattern)
		gg.push("--", ...(a.glob ? [a.glob] : []), ...DENY_PATHSPECS)
		const r = await run(gg, { cwd: repo.root, timeoutMs: 60_000 })
		return hit(
			repo,
			"git-grep",
			r.stdout,
			"chua cai ripgrep nen dung git grep: chi tim trong file da track",
		)
	}
}

export async function ripgrep(a: Args) {
	const targets = a.all_repos ? allRepos() : [resolveRepo(a.repo)]
	const searched = targets.slice(0, MAX_REPOS)

	// Song song co tran: 4 tien trinh rg cung luc — truoc day chay tuan tu,
	// 20 repo co the mat >1s. Gioi han 4 de khong treo may khi repo nhieu.
	const results = await mapLimit(searched, 4, (repo) => grepOne(repo, a))

	return {
		repos_searched: searched.map((r) => r.name),
		...(targets.length > searched.length
			? { skipped_repos: targets.slice(MAX_REPOS).map((r) => r.name) }
			: {}),
		results: results.filter((r) => a.all_repos === true ? r.matches.trim().length > 0 : true),
		...(a.all_repos ? { note: "chi liet ke repo co ket qua" } : {}),
	}
}

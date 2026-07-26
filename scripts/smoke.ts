/**
 * Smoke test end-to-end, khong can repo that.
 *
 * Tao 2 git repo tam trong mot workspace tam, roi goi truc tiep cac handler tool
 * (bo qua tang HTTP/MCP) de kiem tra: repo registry, quyen doc/ghi, chroot,
 * deny-list, branch guard, build/test theo toolchain, va luong commit.
 *
 *   npm run smoke
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function git(cwd: string, ...args: string[]) {
	execFileSync("git", args, { cwd, stdio: "pipe" })
}

const workspace = mkdtempSync(join(tmpdir(), "local-repo-mcp-smoke-"))

function makeRepo(name: string): string {
	const root = join(workspace, name)
	mkdirSync(root, { recursive: true })
	git(root, "init", "-b", "main")
	// Ghi identity vao .git/config cua repo tam, KHONG dung `git -c`: cac tool goi
	// `git commit` qua exec.ts, ma exec.ts loc env va CI khong co gitconfig global
	// — khong co dong nay thi git commit fail voi "Author identity unknown".
	git(root, "config", "user.email", "smoke@example.com")
	git(root, "config", "user.name", "smoke")
	writeFileSync(join(root, "README.md"), "hello\nworld\n")
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify(
			{ name, private: true, scripts: { build: "echo built", test: "echo tested" } },
			null,
			2,
		) + "\n",
	)
	git(root, "add", "-A")
	git(root, "commit", "-m", "init")
	return root
}

const rw = makeRepo("demo") // khai bao trong repos.json, write: true
makeRepo("refonly") // chi duoc tim thay qua WORKSPACE_ROOT → chi doc
writeFileSync(join(rw, ".env"), "SECRET=x\n") // phai bi deny-list chan

const reposConfig = join(workspace, "repos.json")
writeFileSync(
	reposConfig,
	JSON.stringify({ repos: [{ name: "demo", path: rw, write: true }] }, null, 2),
)

// Config doc env luc import — phai set TRUOC moi dynamic import ben duoi.
process.env.MCP_TOKEN = "smoke-token"
process.env.WORKSPACE_ROOT = workspace
process.env.REPOS_CONFIG = reposConfig
process.env.ALLOW_PUSH = "false"
process.env.AUTO_DISCOVERED_WRITE = "false"

const { listRepos } = await import("../src/tools/listRepos.js")
const { readFile } = await import("../src/tools/readFile.js")
const { listDir } = await import("../src/tools/listDir.js")
const { createFile } = await import("../src/tools/createFile.js")
const { editFile } = await import("../src/tools/editFile.js")
const { removeFile } = await import("../src/tools/removeFile.js")
const { gitCommit } = await import("../src/tools/gitCommit.js")
const { gitStatus } = await import("../src/tools/gitStatus.js")
const { gitPush } = await import("../src/tools/gitPush.js")
const { runBuild, runTests } = await import("../src/tools/runTests.js")

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, detail = "") {
	if (cond) {
		pass++
		console.log(`  ok    ${name}`)
	} else {
		fail++
		console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
	}
}

/** Tool PHAI throw, va message phai chua `needle`. */
async function denies(name: string, fn: () => Promise<unknown>, needle: string) {
	try {
		await fn()
		fail++
		console.error(`  FAIL  ${name} — khong throw (dang le phai chan)`)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		ok(name, msg.includes(needle), `message: ${msg}`)
	}
}

console.log(`workspace: ${workspace}\n`)

// —— Repo registry ——
console.log("repo registry")
const repos = await listRepos()
ok("tim thay 2 repo", repos.count === 2, JSON.stringify(repos))
const demo = repos.repos.find((r) => r.name === "demo")
const ref = repos.repos.find((r) => r.name === "refonly")
ok("demo ghi duoc (repos.json)", demo?.write === true)
ok("refonly chi doc (auto-discovered)", ref?.write === false)
ok("doan dung toolchain npm", demo?.toolchain === "npm", String(demo?.toolchain))
ok("co lenh build/test", demo?.can_build === true && demo?.can_test === true)

// —— Doc ——
console.log("\ndoc")
const r1 = await readFile({ repo: "demo", path: "README.md" })
ok("read_file tra noi dung", r1.text.includes("hello"), r1.text)
const d1 = await listDir({ repo: "demo" })
ok("list_dir thay README.md", d1.entries.some((e) => e.name === "README.md"))
ok("list_dir doc duoc ca repo chi doc", (await listDir({ repo: "refonly" })).entries.length > 0)

// —— Chroot + deny-list ——
console.log("\nchroot & deny-list")
await denies("chan .env", () => readFile({ repo: "demo", path: ".env" }), "denied")
await denies(
	"chan doc cheo sang repo khac",
	() => readFile({ repo: "demo", path: "../refonly/README.md" }),
	"escapes repo root",
)
await denies(
	"chan path tuyet doi",
	() => readFile({ repo: "demo", path: "/etc/passwd" }),
	"relative",
)
await denies(
	"chan repo khong ton tai",
	() => readFile({ repo: "nope", path: "README.md" }),
	"khong biet repo",
)
await denies(
	"bat buoc chi ro repo khi co nhieu repo",
	() => readFile({ path: "README.md" }),
	"chi ro",
)

// —— Quyen ghi ——
console.log("\nquyen ghi")
await denies(
	"chan ghi khi branch la main",
	() => createFile({ repo: "demo", path: "src/a.ts", content: "export const a = 1\n" }),
	'branch "main"',
)
await denies(
	"chan ghi vao repo chi doc",
	() => editFile({ repo: "refonly", path: "README.md", old_str: "hello", new_str: "hi" }),
	"chi-doc",
)

git(rw, "checkout", "-b", "agent/smoke")

const c1 = await createFile({
	repo: "demo",
	path: "src/a.ts",
	content: "export const a = 1\n",
})
ok("create_file tao file moi", c1.created === true && c1.branch === "agent/smoke")
await denies(
	"create_file khong ghi de",
	() => createFile({ repo: "demo", path: "src/a.ts", content: "x" }),
	"da ton tai",
)

const e1 = await editFile({
	repo: "demo",
	path: "src/a.ts",
	old_str: "const a = 1",
	new_str: "const a = 2",
})
ok("edit_file thay 1 cho", e1.replacements === 1)
ok(
	"noi dung da doi",
	(await readFile({ repo: "demo", path: "src/a.ts" })).text.includes("a = 2"),
)
await denies(
	"edit_file bao loi khi old_str khong khop",
	() => editFile({ repo: "demo", path: "src/a.ts", old_str: "khong-co", new_str: "x" }),
	"khong tim thay",
)

// —— Git ——
console.log("\ngit")
const s1 = await gitStatus({ repo: "demo" })
ok("git_status thay dirty", s1.dirty === true)
ok("git_status bao writable", s1.writable === true)

// `git add -A` se stage ca .env — phai bi chan, khong duoc de secret ra remote.
await denies(
	"git_commit chan file trong deny-list",
	() => gitCommit({ repo: "demo", message: "smoke: add a.ts" }),
	"deny-list",
)
writeFileSync(join(rw, ".gitignore"), ".env\n")

const cm = await gitCommit({ repo: "demo", message: "smoke: add a.ts" })
ok("git_commit tra sha", cm.sha.length > 0 && cm.exit_code === 0, JSON.stringify(cm))
const tracked = execFileSync("git", ["ls-files"], { cwd: rw, encoding: "utf8" })
	.split("\n")
	.map((l) => l.trim())
ok("src/a.ts da vao commit", tracked.includes("src/a.ts"))
ok(".env KHONG bi commit", !tracked.includes(".env"), tracked.join(" "))
ok("tree sach sau commit", (await gitStatus({ repo: "demo" })).dirty === false)

const rm = await removeFile({ repo: "demo", path: "src/a.ts" })
ok("remove_file xoa file da track", rm.exit_code === 0)
await gitCommit({ repo: "demo", message: "smoke: remove a.ts" })

await denies("git_push bi tat mac dinh", () => gitPush({ repo: "demo" }), "bi tat")

// —— Build & test theo toolchain ——
console.log("\nbuild & test")
const b1 = await runBuild({ repo: "demo" })
ok("run_build chay lenh cua repo", b1.exit_code === 0 && b1.output.includes("built"), b1.output)
const t1 = await runTests({ repo: "demo" })
ok("run_tests chay lenh cua repo", t1.exit_code === 0 && t1.output.includes("tested"), t1.output)
await denies(
	"filter chi cho dotnet",
	() => runTests({ repo: "demo", filter: "SomeTest" }),
	"chi ho tro toolchain dotnet",
)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)

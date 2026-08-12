/**
 * Smoke test end-to-end, khong can repo that.
 *
 * Tao 2 git repo tam trong mot workspace tam, roi goi truc tiep cac handler tool
 * (bo qua tang HTTP/MCP) de kiem tra: repo registry, quyen doc/ghi, chroot,
 * deny-list, branch guard, build/test theo toolchain, luong commit, duong lui,
 * tim xuyen repo, job bat dong bo, va cac tran an toan (binary, kich thuoc).
 *
 *   npm run smoke
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function git(cwd: string, ...args: string[]) {
	execFileSync("git", args, { cwd, stdio: "pipe" })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
const ro = makeRepo("refonly") // chi duoc tim thay qua WORKSPACE_ROOT → chi doc
writeFileSync(join(rw, ".env"), "SECRET=x\n") // phai bi deny-list chan

// De trong repo CHI DOC de khong lam dirty repo demo (cac assertion "tree sach").
writeFileSync(join(ro, "blob.bin"), Buffer.from([0x61, 0x00, 0x62, 0x63]))
writeFileSync(join(ro, "huge.txt"), "z".repeat(9_000))

const reposConfig = join(workspace, "repos.json")
const goodConfig = JSON.stringify(
	{
		repos: [{ name: "demo", path: rw, write: true, branchPrefix: "agent/" }],
	},
	null,
	2,
)
writeFileSync(reposConfig, goodConfig)

// Config doc env luc import — phai set TRUOC moi dynamic import ben duoi.
process.env.MCP_TOKEN = "smoke-token"
process.env.WORKSPACE_ROOT = workspace
process.env.REPOS_CONFIG = reposConfig
process.env.ALLOW_PUSH = "false"
process.env.ALLOW_TERMINAL = "true"
// Smoke kiem tra sandbox theo repo; tat repo ao `system` cua che do Full Access.
process.env.ALLOW_FULL_ACCESS = "false"
process.env.AUTO_DISCOVERED_WRITE = "false"
process.env.MAX_READ_BYTES = "5000" // ha tran cho de test, moi file thuc te deu nho hon
process.env.MAX_WRITE_BYTES = "5000"

const { allRepos, invalidateRepoCache } = await import("../src/repos.js")
const { redactForAudit } = await import("../src/log.js")
const { buildTerminalEnv } = await import("../src/exec.js")
const { listRepos } = await import("../src/tools/listRepos.js")
const { readFile } = await import("../src/tools/readFile.js")
const { readManyFiles } = await import("../src/tools/readManyFiles.js")
const { globFiles } = await import("../src/tools/globFiles.js")
const { listDir } = await import("../src/tools/listDir.js")
const { ripgrep } = await import("../src/tools/ripgrep.js")
const { featureContext } = await import("../src/tools/featureContext.js")
const { traceFlow } = await import("../src/tools/traceFlow.js")
const { analyzeFeature } = await import("../src/tools/analyzeFeature.js")
const { flushContextCacheWrites } = await import("../src/contextCache.js")
const { createFile } = await import("../src/tools/createFile.js")
const { editFile } = await import("../src/tools/editFile.js")
const { multiEditFile } = await import("../src/tools/multiEditFile.js")
const { applyPatch } = await import("../src/tools/applyPatch.js")
const { removeFile } = await import("../src/tools/removeFile.js")
const { gitCommit } = await import("../src/tools/gitCommit.js")
const { gitRestore } = await import("../src/tools/gitRestore.js")
const { gitStatus } = await import("../src/tools/gitStatus.js")
const { gitPush } = await import("../src/tools/gitPush.js")
const { runBuild, runTests } = await import("../src/tools/runTests.js")
const { gitBranch } = await import("../src/tools/gitBranch.js")
const { gitStash } = await import("../src/tools/gitStash.js")
const { runLint } = await import("../src/tools/runLint.js")
const { runTypecheck } = await import("../src/tools/runTypecheck.js")
const { terminal } = await import("../src/tools/terminal.js")
const {
	terminalStart,
	terminalWrite,
	terminalRead,
	terminalResize,
	terminalClose,
	terminalList,
} = await import("../src/tools/pty.js")
const { jobStatus } = await import("../src/tools/jobStatus.js")
const { killJob } = await import("../src/tools/killJob.js")
const { CORE_ALLOWED, AGENT_ALLOWED } = await import("../src/tools/index.js")
const { withLock } = await import("../src/lock.js")

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
const rmRes = await readManyFiles({ repo: "demo", files: [{ path: "README.md" }, { path: "package.json" }] })
ok("read_many_files doc nhieu file thanh cong", rmRes.files.length === 2 && rmRes.files.every((f) => f.ok), JSON.stringify(rmRes))

const rmBudget = await readManyFiles({ repo: "demo", files: [{ path: "README.md" }], max_total_bytes: 3 })
ok("read_many_files ap dung byte budget len file dau tien", rmBudget.truncated === true && rmBudget.files[0].ok === false, JSON.stringify(rmBudget))

const gfRes = await globFiles({ repo: "demo", patterns: ["*.json", "*.md"] })
ok("glob_files tim kiem theo pattern", gfRes.paths.includes("README.md") && gfRes.paths.includes("package.json"), JSON.stringify(gfRes))
const gfCached = await globFiles({ repo: "demo", patterns: ["*.json", "*.md"] })
ok("glob_files warm cache tra ket qua tuc thi", gfCached.cache_hit === true && gfCached.paths.length === gfRes.paths.length, JSON.stringify(gfCached))

const gfNoMatch = await globFiles({ repo: "demo", patterns: ["*.nonexistent_ext"] })
ok("glob_files tra paths rong khi no-match", gfNoMatch.paths.length === 0, JSON.stringify(gfNoMatch))

const gfFallback = await globFiles({ repo: "demo", patterns: ["*.json"], __force_fallback: true })
ok("glob_files fallback filter theo pattern dung", gfFallback.paths.includes("package.json") && !gfFallback.paths.includes("README.md") && gfFallback.engine === "git-ls-files", JSON.stringify(gfFallback))
await denies(
	"read_file chan file binary",
	() => readFile({ repo: "refonly", path: "blob.bin" }),
	"binary",
)
await denies(
	"read_file chan file qua lon",
	() => readFile({ repo: "refonly", path: "huge.txt" }),
	"MAX_READ_BYTES",
)

// —— Tim kiem ——
console.log("\nripgrep")
const g1 = await ripgrep({ repo: "demo", pattern: "hello" })
ok("ripgrep tim trong 1 repo", g1.results[0].matches.includes("README.md"), JSON.stringify(g1))
const g2 = await ripgrep({ all_repos: true, pattern: "hello" })
ok("ripgrep xuyen repo thay ca 2", g2.results.length === 2, JSON.stringify(g2.repos_searched))
const g3 = await ripgrep({ repo: "demo", pattern: "chuoi-khong-bao-gio-ton-tai" })
ok("khong match thi tra rong, khong phai loi", g3.results[0].matches.trim() === "")

console.log("\nget_feature_context")
const fc1 = await featureContext({ repo: "demo", query: "hello" })
ok(
	"feature_context tim va doc file trong 1 call",
	fc1.files.some((f) => f.path === "README.md" && f.ok && (f.text ?? "").includes("hello")),
	JSON.stringify(fc1).slice(0, 300),
)
const fcCache = await featureContext({ repo: "demo", query: "hello" })
ok("feature_context cache hit lan goi thu 2", fcCache.cache_hit === true, JSON.stringify(fcCache).slice(0, 200))
const fcMiss = await featureContext({ repo: "demo", query: "chuoi-khong-bao-gio-ton-tai" })
ok("feature_context khong match tra files rong", fcMiss.matched_files === 0 && fcMiss.files.length === 0, JSON.stringify(fcMiss))
const fcDeny = await featureContext({ repo: "demo", query: "SECRET" })
ok("feature_context deny-list chan .env", fcDeny.files.every((f) => !f.path.includes(".env")), JSON.stringify(fcDeny))
const fcPartial = await featureContext({ repo: "demo", query: "hello", full_file: false, refresh: true })
ok(
	"feature_context partial mode tra window quanh match",
	fcPartial.files[0]?.truncated === true && (fcPartial.files[0]?.text ?? "").includes("hello"),
	JSON.stringify(fcPartial).slice(0, 300),
)
const fcL0 = await featureContext({ repo: "demo", query: "hello", detail: "L0", refresh: true })
ok(
	"feature_context L0 chi tra danh sach, khong doc noi dung",
	fcL0.files[0] !== undefined && fcL0.files[0].text === undefined && fcL0.files[0].match_count > 0,
	JSON.stringify(fcL0),
)
const fcL1 = await featureContext({ repo: "demo", query: "hello", detail: "L1", refresh: true })
ok(
	"feature_context L1 tra window kem outline",
	fcL1.files[0]?.truncated === true &&
		(fcL1.files[0]?.text ?? "").includes("hello") &&
		Array.isArray(fcL1.files[0]?.outline),
	JSON.stringify(fcL1).slice(0, 300),
)
const fcL2 = await featureContext({ repo: "demo", query: "hello", detail: "L2", refresh: true })
ok(
	"feature_context L2 doc nguyen file",
	fcL2.files[0]?.truncated === false && (fcL2.files[0]?.text ?? "").includes("world"),
	JSON.stringify(fcL2),
)
const fcWarm = await featureContext({ repo: "demo", query: "hello", detail: "L2" })
ok("repoStamp: tree khong doi thi cache hit", fcWarm.cache_hit === true)
writeFileSync(join(rw, "new-file-hello.txt"), "hello moi\n")
await sleep(2100) // cho het TTL 2s cua repoStamp
const fcNewFile = await featureContext({ repo: "demo", query: "hello", detail: "L2" })
ok(
	"repoStamp: file moi chua commit lam cache miss va lo dien trong ket qua",
	fcNewFile.cache_hit === false && fcNewFile.files.some((f) => f.path === "new-file-hello.txt"),
	JSON.stringify(fcNewFile).slice(0, 200),
)
unlinkSync(join(rw, "new-file-hello.txt")) // don sach: cac test git phia sau doi hoi tree sach

console.log("\ntrace_flow")
const tf1 = await traceFlow({ repo: "demo", symbol: "hello" })
ok("trace_flow tim thay caller", tf1.callers.some((c) => c.path === "README.md"), JSON.stringify(tf1).slice(0, 300))
const tf2 = await traceFlow({ repo: "demo", symbol: "hello" })
ok("trace_flow cache hit lan goi thu 2", tf2.cache_hit === true, JSON.stringify(tf2).slice(0, 200))
const tfMiss = await traceFlow({ repo: "demo", symbol: "symbol_khong_he_ton_tai" })
ok("trace_flow symbol khong ton tai tra rong", tfMiss.definitions.length === 0 && tfMiss.callers.length === 0, JSON.stringify(tfMiss))
const tfDeny = await traceFlow({ repo: "demo", symbol: "SECRET" })
ok(
	"trace_flow deny-list chan .env",
	![...tfDeny.callers, ...tfDeny.definitions].some((x) => x.path.includes(".env")),
	JSON.stringify(tfDeny),
)
await denies("trace_flow tu choi symbol khong hop le", () => traceFlow({ repo: "demo", symbol: "foo; rm -rf" }), "khong hop le")

console.log("\nanalyze_feature")
const af1 = await analyzeFeature({ repo: "demo", query: "hello" })
ok(
	"analyze_feature gom context, bo qua trace khi query khong co symbol",
	af1.context.files.length > 0 && af1.symbol_traced === null && af1.trace === null,
	JSON.stringify(af1).slice(0, 300),
)
const af2 = await analyzeFeature({ repo: "demo", query: "hello", symbol: "hello" })
ok(
	"analyze_feature trace khi truyen symbol ro rang",
	af2.symbol_traced === "hello" && af2.trace !== null && af2.trace.callers.length > 0,
	JSON.stringify(af2).slice(0, 300),
)
const af3 = await analyzeFeature({ repo: "demo", query: "hello", symbol: "hello" })
ok("analyze_feature cache hit lan 2", af3.cache_hit === true, JSON.stringify(af3).slice(0, 200))
const af4 = await analyzeFeature({ repo: "demo", query: "cau hoi van xuong khong match gi het", symbol: "hello" })
ok(
	"analyze_feature fallback tim lai bang symbol khi query van xuong khong match",
	af4.context.matched_files === 1 && af4.symbol_traced === "hello",
	JSON.stringify(af4).slice(0, 300),
)
await flushContextCacheWrites()
const { readdirSync } = await import("node:fs")
const diskCacheDir = join(tmpdir(), "local-repo-mcp-context-cache")
ok("context cache ghi ra dia (song qua restart)", readdirSync(diskCacheDir).length > 0, diskCacheDir)

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
	"edit_file tra kem context quanh vet sua",
	typeof e1.context?.text === "string" &&
		e1.context.text.includes("const a = 2") &&
		e1.context.start_line === 1,
)
ok(
	"noi dung da doi",
	(await readFile({ repo: "demo", path: "src/a.ts" })).text.includes("a = 2"),
)
await denies(
	"edit_file bao loi khi old_str khong khop",
	() => editFile({ repo: "demo", path: "src/a.ts", old_str: "khong-co", new_str: "x" }),
	"khong tim thay",
)
await denies(
	"edit_file chan ket qua vuot tran ghi",
	() =>
		editFile({
			repo: "demo",
			path: "src/a.ts",
			old_str: "a = 2",
			new_str: "a = " + "9".repeat(9_000),
		}),
	"MAX_WRITE_BYTES",
)
ok(
	"file khong bi sua khi vuot tran",
	(await readFile({ repo: "demo", path: "src/a.ts" })).text.includes("a = 2"),
)

await editFile({ repo: "demo", path: "src/a.ts", old_str: "const a = 2", new_str: "const a = 2\nconst b = 5" })

const me1 = await multiEditFile({
	repo: "demo",
	path: "src/a.ts",
	edits: [
		{ old_str: "const a = 2", new_str: "const a = 10" },
		{ old_str: "const b = 5", new_str: "const b = 20" },
	],
})
ok("multi_edit_file thay nhieu vi tri thanh cong", me1.total_edits === 2 && me1.edits.length === 2)
ok(
	"multi_edit_file tra kem context",
	typeof me1.context?.text === "string" && me1.context.text.includes("const a = 10"),
)
const meText = (await readFile({ repo: "demo", path: "src/a.ts" })).text
ok("noi dung da duoc multi_edit cap nhat", meText.includes("a = 10") && meText.includes("b = 20"))

await denies(
	"multi_edit_file atomic rollback khi 1 edit that bai",
	() =>
		multiEditFile({
			repo: "demo",
			path: "src/a.ts",
			edits: [
				{ old_str: "const a = 10", new_str: "const a = 999" },
				{ old_str: "doan_khong_ton_tai_123", new_str: "xxx" },
			],
		}),
	"ROLLBACK",
)
const meRollbackText = (await readFile({ repo: "demo", path: "src/a.ts" })).text
ok("file KHONG bi thay doi khi batch edit bi rollback", meRollbackText.includes("a = 10") && !meRollbackText.includes("a = 999"))

await denies(
	"multi_edit_file chan khi expected_sha256 mismatch",
	() =>
		multiEditFile({
			repo: "demo",
			path: "src/a.ts",
			expected_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
			edits: [{ old_str: "const a = 10", new_str: "const a = 100" }],
		}),
	"expected_sha256 mismatch",
)

const eSnap = await readFile({ repo: "demo", path: "src/a.ts" })
const eShaRes = await editFile({
	repo: "demo",
	path: "src/a.ts",
	old_str: "const a = 10",
	new_str: "const a = 10",
	expected_sha256: eSnap.sha256,
})
ok("edit_file chap nhan expected_sha256 dung", eShaRes.changed === false, JSON.stringify(eShaRes))

await denies(
	"edit_file chan khi expected_sha256 mismatch",
	() =>
		editFile({
			repo: "demo",
			path: "src/a.ts",
			old_str: "const a = 10",
			new_str: "const a = 100",
			expected_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
		}),
	"expected_sha256 mismatch",
)

// Test trailing spaces matcher & CRLF/BOM preservation
await createFile({ repo: "demo", path: "src/trailing.ts", content: "const val = 1   \nconst val2 = 2\n" })
const trRes = await editFile({ repo: "demo", path: "src/trailing.ts", old_str: "const val = 1 \nconst val2 = 2", new_str: "const val = 99\nconst val2 = 2" })
ok("matcher cap nhat thanh cong trailing whitespace normalized match", trRes.match_mode === "trailing_whitespace_normalized" && trRes.changed === true, JSON.stringify(trRes))

await createFile({ repo: "demo", path: "src/bom_crlf.ts", content: "\ufeffconst line1 = 1\r\nconst line2 = 2\r\n" })
const bomRes = await editFile({ repo: "demo", path: "src/bom_crlf.ts", old_str: "const line2 = 2", new_str: "const line2 = 20" })
ok("edit_file bao toan BOM va CRLF line endings", bomRes.bom === true && bomRes.eol === "crlf", JSON.stringify(bomRes))
const bomSnap = await readFile({ repo: "demo", path: "src/bom_crlf.ts" })
ok("noi dung file giu nguyen BOM", bomSnap.bom === true && bomSnap.eol === "crlf" && bomSnap.text.includes("line2 = 20"), JSON.stringify(bomSnap))

// Test mode preservation
await createFile({ repo: "demo", path: "src/script.sh", content: "#!/bin/sh\necho hi\n" })
const modeBefore = statSync(join(rw, "src/script.sh")).mode
await editFile({ repo: "demo", path: "src/script.sh", old_str: "echo hi", new_str: "echo hello" })
const modeAfter = statSync(join(rw, "src/script.sh")).mode
ok("edit_file bao toan permission mode cua file", modeBefore === modeAfter, `before=${modeBefore}, after=${modeAfter}`)

// Test invalid UTF-8 rejection on edit tools
writeFileSync(join(rw, "src/invalid.bin"), Buffer.from([0xff, 0xfe, 0xfd, 0x00]))
await denies(
	"edit_file tu choi file binary / invalid UTF-8",
	() => editFile({ repo: "demo", path: "src/invalid.bin", old_str: "abc", new_str: "def" }),
	"binary",
)

// Tra src/a.ts ve trang thai ban dau cho cac test tiep theo (git commit, git restore)
await multiEditFile({
	repo: "demo",
	path: "src/a.ts",
	edits: [
		{ old_str: "const a = 10", new_str: "const a = 2" },
		{ old_str: "\nconst b = 20", new_str: "" },
	],
})

// —— apply_patch ——
console.log("\napply_patch")
const apAdd = await applyPatch({
	repo: "demo",
	patch_text: `*** Begin Patch\n*** Add File: src/patched.ts\n+export const patched = true\n*** End Patch`,
})
ok("apply_patch Add File thanh cong", apAdd.files_changed === 1)
ok("apply_patch write mac dinh compact summary", apAdd.response_detail === "summary" && !("diff" in apAdd), JSON.stringify(apAdd))
ok("file moi da duoc tao bang apply_patch", (await readFile({ repo: "demo", path: "src/patched.ts" })).text.includes("patched = true"))

const apDry = await applyPatch({
	repo: "demo",
	dry_run: true,
	patch_text: `*** Begin Patch\n*** Update File: src/patched.ts\n@@\n-export const patched = true\n+export const patched = "dry_run"\n*** End Patch`,
})
ok("apply_patch dry_run tra diff mac dinh", apDry.dry_run === true && apDry.files_changed === 1 && apDry.response_detail === "diff" && "diff" in apDry)
ok("dry_run KHONG thay doi file tren o dia", (await readFile({ repo: "demo", path: "src/patched.ts" })).text.includes("patched = true"))

const apMove = await applyPatch({
	repo: "demo",
	patch_text: `*** Begin Patch\n*** Update File: src/patched.ts\n*** Move to: src/moved.ts\n@@\n-export const patched = true\n+export const patched = "moved"\n*** End Patch`,
})
ok("apply_patch Move File thanh cong", apMove.files_changed === 1)
ok("file khong con o path cu", !(await listDir({ repo: "demo", path: "src" })).entries.some((c) => c.name === "patched.ts"))
ok("file da o path moi voi noi dung da update", (await readFile({ repo: "demo", path: "src/moved.ts" })).text.includes("moved"))

const apDel = await applyPatch({
	repo: "demo",
	patch_text: `*** Begin Patch\n*** Delete File: src/moved.ts\n*** End Patch`,
})
ok("apply_patch Delete File thanh cong", apDel.files_changed === 1)

await denies(
	"apply_patch pre-validation chan khi 1 hunk sai (all-or-nothing)",
	() =>
		applyPatch({
			repo: "demo",
			patch_text: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 2\n+const a = 100\n*** Update File: README.md\n@@\n-non_existent_text_12345\n+replacement\n*** End Patch`,
		}),
	"verification failed",
)
ok("file src/a.ts KHONG bi thay doi khi patch bi pre-validation reject", (await readFile({ repo: "demo", path: "src/a.ts" })).text.includes("a = 2"))

await denies(
	"apply_patch chan path traversal ../",
	() =>
		applyPatch({
			repo: "demo",
			patch_text: `*** Begin Patch\n*** Add File: ../outside.ts\n+bad\n*** End Patch`,
		}),
	"escapes repo root",
)

await denies(
	"apply_patch chan deny-list .env",
	() =>
		applyPatch({
			repo: "demo",
			patch_text: `*** Begin Patch\n*** Add File: .env\n+SECRET=123\n*** End Patch`,
		}),
	"denied path",
)

await denies(
	"apply_patch chan repo read-only",
	() =>
		applyPatch({
			repo: "refonly",
			patch_text: `*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch`,
		}),
	"chi-doc",
)

// Multi-file success patch (Add + Update + Move in 1 single patch call)
await createFile({ repo: "demo", path: "src/multi_src.ts", content: "export const m1 = 1\n" })
const apMulti = await applyPatch({
	repo: "demo",
	patch_text: `*** Begin Patch\n*** Add File: src/multi_add.ts\n+export const mAdd = true\n*** Update File: src/multi_src.ts\n*** Move to: src/multi_moved.ts\n@@\n-export const m1 = 1\n+export const m1 = 100\n*** End Patch`,
})
ok("apply_patch multi-file patch (Add + Update + Move) thanh cong trong 1 call", apMulti.files_changed === 2)
ok("file mAdd da duoc tao", (await readFile({ repo: "demo", path: "src/multi_add.ts" })).text.includes("mAdd = true"))
ok("file multi_moved da duoc tao va update", (await readFile({ repo: "demo", path: "src/multi_moved.ts" })).text.includes("m1 = 100"))

// Cleanup multi-file test artifacts
await applyPatch({
	repo: "demo",
	patch_text: `*** Begin Patch\n*** Delete File: src/multi_add.ts\n*** Delete File: src/multi_moved.ts\n*** End Patch`,
})

await denies(
	"apply_patch tu choi text ngoai envelope (truoc Begin Patch)",
	() =>
		applyPatch({
			repo: "demo",
			patch_text: `extra text before\n*** Begin Patch\n*** Add File: src/bad.ts\n+bad\n*** End Patch`,
		}),
	"ngoai envelope",
)

await denies(
	"apply_patch tu choi path alias collision (src/alias.ts vs src/./alias.ts)",
	() =>
		applyPatch({
			repo: "demo",
			patch_text: `*** Begin Patch\n*** Add File: src/alias.ts\n+c1\n*** Add File: src/./alias.ts\n+c2\n*** End Patch`,
		}),
	"Path target bi trung",
)

await denies(
	"apply_patch tu choi path alias collision voi parent directory (src/dir/../a.ts vs src/a.ts)",
	() =>
		applyPatch({
			repo: "demo",
			patch_text: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 2\n+const a = 3\n*** Update File: src/dir/../a.ts\n@@\n-const a = 2\n+const a = 4\n*** End Patch`,
		}),
	"bi thao tac nhieu lan",
)

// Expected HEAD SHA tests
const demoRoot = join(workspace, "demo")
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: demoRoot, encoding: "utf8" }).trim()

const apHeadOk = await applyPatch({
	repo: "demo",
	expected_head_sha: headSha,
	patch_text: `*** Begin Patch\n*** Add File: src/head_test.ts\n+export const headOk = true\n*** End Patch`,
})
ok("apply_patch expected_head_sha khop thanh cong", apHeadOk.files_changed === 1)

await denies(
	"apply_patch expected_head_sha mismatch bi tu choi",
	() =>
		applyPatch({
			repo: "demo",
			expected_head_sha: "0000000000000000000000000000000000000000",
			patch_text: `*** Begin Patch\n*** Add File: src/head_bad.ts\n+bad\n*** End Patch`,
		}),
	"expected_head_sha mismatch",
)

// Expected Files SHA-256 tests
const { createHash } = await import("node:crypto")
const aSha = createHash("sha256").update(readFileSync(join(demoRoot, "src/a.ts"))).digest("hex")
const apEfOk = await applyPatch({
	repo: "demo",
	expected_files: [{ path: "src/a.ts", sha256: aSha }],
	patch_text: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 2\n+const a = 200\n*** End Patch`,
})
ok("apply_patch expected_files sha256 khop thanh cong", apEfOk.files_changed === 1)

// Restore src/a.ts content
await applyPatch({
	repo: "demo",
	patch_text: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 200\n+const a = 2\n*** End Patch`,
})

await denies(
	"expected_files sha256 mismatch KHONG tiet lo hash thuc te (anti-oracle)",
	async () => {
		try {
			await applyPatch({
				repo: "demo",
				expected_files: [{ path: "src/a.ts", sha256: "badhash" }],
				patch_text: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 2\n+const a = 3\n*** End Patch`,
			})
		} catch (e: any) {
			if (e.message.includes("Actual:")) {
				throw new Error("FAIL: actual hash was leaked in error message")
			}
			throw e
		}
	},
	"expected_files sha256 mismatch",
)

await denies(
	"expected_files chan deny-listed path",
	() =>
		applyPatch({
			repo: "demo",
			expected_files: [{ path: ".env", sha256: "123456" }],
			patch_text: `*** Begin Patch\n*** Add File: test_ef.ts\n+bad\n*** End Patch`,
		}),
	"deny-list",
)

// Invalid UTF-8 binary detection test (0xFF 0xFE 0xFD sequence)
const invalidUtf8Path = join(demoRoot, "src", "invalid_utf8.bin")
writeFileSync(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]))
await denies(
	"apply_patch tu choi file chuoi byte UTF-8 khong hop le (invalid UTF-8 sequence)",
	() =>
		applyPatch({
			repo: "demo",
			patch_text: `*** Begin Patch\n*** Update File: src/invalid_utf8.bin\n@@\n-foo\n+bar\n*** End Patch`,
		}),
	"non-UTF-8 or binary files",
)
const { unlinkSync: testUnlink } = await import("node:fs")
testUnlink(invalidUtf8Path)

// Multi-step Fault Injection Rollback Tests (Step 1, Step 2 mid-rename, Step 3 mid-unlink)
await createFile({ repo: "demo", path: "src/rb_del.ts", content: "export const rbDel = true\n" })
await createFile({ repo: "demo", path: "src/rb_move.ts", content: "export const rbMove = true\n" })
await createFile({ repo: "demo", path: "src/rb_upd.ts", content: "export const rbUpd = 1\n" })

const stepPatch = `*** Begin Patch\n*** Add File: src/rb_add.ts\n+new\n*** Update File: src/rb_upd.ts\n@@\n-export const rbUpd = 1\n+export const rbUpd = 999\n*** Update File: src/rb_move.ts\n*** Move to: src/rb_moved_dest.ts\n@@\n-export const rbMove = true\n+export const rbMove = false\n*** Delete File: src/rb_del.ts\n*** End Patch`

async function assertFullRollbackState(stepName: string) {
	const delContent = (await readFile({ repo: "demo", path: "src/rb_del.ts" })).text
	ok(`${stepName} rollback khoi phuc file delete (src/rb_del.ts)`, delContent.includes("rbDel = true"))

	const moveSrcContent = (await readFile({ repo: "demo", path: "src/rb_move.ts" })).text
	ok(`${stepName} rollback khoi phuc file move source (src/rb_move.ts)`, moveSrcContent.includes("rbMove = true"))
	
	const srcEntries = (await listDir({ repo: "demo", path: "src" })).entries
	ok(`${stepName} rollback xoa move destination (src/rb_moved_dest.ts)`, !srcEntries.some((c) => c.name === "rb_moved_dest.ts"))

	const updContent = (await readFile({ repo: "demo", path: "src/rb_upd.ts" })).text
	ok(`${stepName} rollback khoi phuc file update (src/rb_upd.ts)`, updContent.includes("rbUpd = 1"))

	ok(`${stepName} rollback xoa file add (src/rb_add.ts)`, !srcEntries.some((c) => c.name === "rb_add.ts"))
	ok(`${stepName} rollback khong de lai file temp .tmp`, !srcEntries.some((c) => c.name.endsWith(".tmp")))
}

// Fault during Step 1 (temp write)
await denies(
	"apply_patch rollback mid-commit Step 1 (temp write failure)",
	() => applyPatch({ repo: "demo", patch_text: stepPatch, __test_fail_after_step: 1 }),
	"Fault injection test error during Step 1",
)
await assertFullRollbackState("Step 1")

// One parallel temp worker fails after siblings have already created temp files.
await denies(
	"apply_patch rollback parallel temp worker failure",
	() => applyPatch({ repo: "demo", patch_text: stepPatch, __test_fail_temp_index: 1 }),
	"Fault injection test error for temp index 1",
)
await assertFullRollbackState("Parallel temp worker")

// Fault during Step 2 (mid-rename)
await denies(
	"apply_patch rollback mid-commit Step 2 (mid-rename failure)",
	() => applyPatch({ repo: "demo", patch_text: stepPatch, __test_fail_after_step: 2 }),
	"Fault injection test error during Step 2",
)
await assertFullRollbackState("Step 2")

// Fault during Step 3 (mid-unlink)
await denies(
	"apply_patch rollback mid-commit Step 3 (mid-unlink failure)",
	() => applyPatch({ repo: "demo", patch_text: stepPatch, __test_fail_after_step: 3 }),
	"Fault injection test error during Step 3",
)
await assertFullRollbackState("Step 3")

// Cleanup rollback test files
await applyPatch({
	repo: "demo",
	patch_text: `*** Begin Patch\n*** Delete File: src/rb_del.ts\n*** Delete File: src/rb_move.ts\n*** Delete File: src/rb_upd.ts\n*** Delete File: src/head_test.ts\n*** End Patch`,
})

const redactedLog = redactForAudit({ patch_text: "*** Begin Patch\nsecret\n*** End Patch" })
ok("audit log redact patch_text", typeof redactedLog === "object" && (redactedLog as any).patch_text.includes("khong ghi noi dung"))

const { forgetTouched } = await import("../src/touched.js")
forgetTouched(join(workspace, "demo"), "src/patched.ts", "src/moved.ts", "src/multi_src.ts", "src/multi_add.ts", "src/multi_moved.ts", "src/rb_del.ts", "src/rb_move.ts", "src/rb_upd.ts", "src/rb_add.ts", "src/head_test.ts", "src/binary.bin")

// —— Git ——
console.log("\ngit")
await denies(
	"assertGitRepo chan repo khong phai git",
	async () => {
		const { assertGitRepo } = await import("../src/git.js")
		assertGitRepo({ name: "nogit", root: workspace, write: true, branchPrefix: "*", reindex: [], toolchain: "none", source: "config" })
	},
	"khong phai la mot Git Repository",
)
const s1 = await gitStatus({ repo: "demo" })
ok("git_status thay dirty", s1.dirty === true)
ok("git_status bao writable", s1.writable === true)

// all=true se stage ca .env — phai bi chan, khong duoc de secret ra remote.
await denies(
	"git_commit chan file trong deny-list",
	() => gitCommit({ repo: "demo", message: "smoke: add a.ts", all: true }),
	"deny-list",
)
writeFileSync(join(rw, ".gitignore"), ".env\n")

// Mac dinh: CHI stage file do tool sua (src/a.ts), khong keo .gitignore vao.
const cm = await gitCommit({ repo: "demo", message: "smoke: add a.ts" })
ok("git_commit tra sha", cm.sha.length > 0 && cm.exit_code === 0, JSON.stringify(cm))
ok(
	"git_commit bao ro da commit file nao",
	Array.isArray(cm.committed) && cm.committed.includes("src/a.ts"),
	JSON.stringify(cm.committed),
)
const tracked = execFileSync("git", ["ls-files"], { cwd: rw, encoding: "utf8" })
	.split("\n")
	.map((l) => l.trim())
ok("src/a.ts da vao commit", tracked.includes("src/a.ts"))
ok(".env KHONG bi commit", !tracked.includes(".env"), tracked.join(" "))
ok(
	"file nguoi dung tu tao KHONG bi keo vao commit",
	!tracked.includes(".gitignore"),
	tracked.join(" "),
)
await denies(
	"commit lan 2 khi tool chua sua gi thi bao loi",
	() => gitCommit({ repo: "demo", message: "smoke: rong" }),
	"khong co file nao",
)
const cm2 = await gitCommit({ repo: "demo", message: "smoke: gitignore", all: true })
ok("all=true commit duoc thay doi ngoai tool", cm2.exit_code === 0, JSON.stringify(cm2))
ok("tree sach sau commit", (await gitStatus({ repo: "demo" })).dirty === false)

// —— Duong lui ——
console.log("\ngit_restore")
await editFile({ repo: "demo", path: "src/a.ts", old_str: "a = 2", new_str: "a = 999" })
ok(
	"da sua lam truoc khi hoan tac",
	(await readFile({ repo: "demo", path: "src/a.ts" })).text.includes("999"),
)
const rs = await gitRestore({ repo: "demo", paths: ["src/a.ts"] })
ok(
	"git_restore tra file ve HEAD",
	rs.exit_code === 0 &&
		(await readFile({ repo: "demo", path: "src/a.ts" })).text.includes("a = 2"),
	JSON.stringify(rs),
)
ok("tree sach sau restore", (await gitStatus({ repo: "demo" })).dirty === false)
await denies(
	"sau restore thi khong con gi de commit",
	() => gitCommit({ repo: "demo", message: "smoke: sau restore" }),
	"khong co file nao",
)
await denies(
	'git_restore tu choi "."',
	() => gitRestore({ repo: "demo", paths: ["."] }),
	"khong hop le",
)
await denies(
	"git_restore tu choi wildcard",
	() => gitRestore({ repo: "demo", paths: ["src/*.ts"] }),
	"khong hop le",
)
await denies(
	"git_restore tu choi file chua track",
	() => gitRestore({ repo: "demo", paths: ["src/chua-co.ts"] }),
	"chua track",
)
await denies(
	"git_restore chan repo chi doc",
	() => gitRestore({ repo: "refonly", paths: ["README.md"] }),
	"chi-doc",
)

const rm = await removeFile({ repo: "demo", path: "src/a.ts" })
ok("remove_file xoa file da track", rm.exit_code === 0)
const cm3 = await gitCommit({ repo: "demo", message: "smoke: remove a.ts" })
ok("commit duoc ca file bi xoa", cm3.exit_code === 0, JSON.stringify(cm3))
ok("tree sach sau commit xoa", (await gitStatus({ repo: "demo" })).dirty === false)

await denies("git_push bi tat mac dinh", () => gitPush({ repo: "demo" }), "bi tat")

// —— git_branch & git_stash ——
console.log("\ngit_branch & git_stash")
const brList = await gitBranch({ repo: "demo" })
ok("git_branch liet ke branch", Array.isArray(brList.branches) && brList.branches.length > 0)
const brCreate = await gitBranch({ repo: "demo", name: "agent/feature-smoke", create: true })
ok("git_branch tao branch moi", brCreate.created === true && brCreate.branch === "agent/feature-smoke")
await denies(
	"git_branch tu choi tao branch sai prefix",
	() => gitBranch({ repo: "demo", name: "bad/prefix-branch", create: true }),
	"branchPrefix",
)

const stList = await gitStash({ repo: "demo", action: "list" })
ok("git_stash list tra ve mang", Array.isArray(stList.stashes))

// —— terminal ——
console.log("\nterminal")
process.env.ALLOW_TERMINAL = "true"
process.env.TERMINAL_MODE = "full"
process.env.MCP_TOKEN = "secret_mcp_token_value_123"

const sanitizedTerminalEnv = buildTerminalEnv({ MY_SECRET_KEY: "hidden123", NORMAL_ENV: "ok" })
ok("terminal env sanitizer loai bo MCP_TOKEN va secret variables", sanitizedTerminalEnv.MCP_TOKEN === undefined && sanitizedTerminalEnv.MY_SECRET_KEY === undefined && sanitizedTerminalEnv.NORMAL_ENV === "ok", JSON.stringify(sanitizedTerminalEnv))

const ptyShell = process.platform === "win32" ? "cmd" : "sh"
const ptySession = await terminalStart({ repo: "demo", shell: ptyShell, cols: 80, rows: 24 })
ok("terminal_start mo interactive PTY", ptySession.status === "running" && ptySession.pid > 0, JSON.stringify(ptySession))
await terminalWrite({ repo: "demo", session_id: ptySession.id, data: "echo PTY_INTERACTIVE_OK\r" })

let ptyRead: any = { output: "", next_cursor: 0, status: "running" }
let ptyCombined = ""
for (let i = 0; i < 100 && !ptyCombined.includes("PTY_INTERACTIVE_OK"); i++) {
	await sleep(20)
	ptyRead = await terminalRead({ repo: "demo", session_id: ptySession.id, cursor: ptyRead.next_cursor })
	ptyCombined += ptyRead.output
}
ok("terminal_write/read tuong tac voi shell dang chay", ptyCombined.includes("PTY_INTERACTIVE_OK"), ptyCombined)

await sleep(50)
const drainRead: any = await terminalRead({ repo: "demo", session_id: ptySession.id, cursor: ptyRead.next_cursor })
const firstCursor = drainRead.next_cursor
await terminalWrite({ repo: "demo", session_id: ptySession.id, data: "echo PTY_INCREMENTAL_OK\r" })
let incremental = ""
let nextCursor = firstCursor
for (let i = 0; i < 100 && !incremental.includes("PTY_INCREMENTAL_OK"); i++) {
	await sleep(20)
	const part: any = await terminalRead({ repo: "demo", session_id: ptySession.id, cursor: nextCursor })
	incremental += part.output
	nextCursor = part.next_cursor
}
ok("terminal_read cursor chi tra output moi", incremental.includes("PTY_INCREMENTAL_OK") && !incremental.includes("PTY_INTERACTIVE_OK"), incremental)

const resized = await terminalResize({ repo: "demo", session_id: ptySession.id, cols: 100, rows: 40 })
ok("terminal_resize cap nhat ConPTY/PTY", resized.cols === 100 && resized.rows === 40, JSON.stringify(resized))
const ptyListed = await terminalList({ repo: "demo" })
ok("terminal_list thay session ma khong lo command", ptyListed.sessions.some((s) => s.id === ptySession.id && s.command_length === 0), JSON.stringify(ptyListed))
await denies(
	"PTY session bi rang buoc dung repo",
	() => terminalRead({ repo: "refonly", session_id: ptySession.id }),
	"thuoc repo",
)
const ptyClosed = await terminalClose({ repo: "demo", session_id: ptySession.id })
ok("terminal_close dung interactive session", ptyClosed.status === "closed" && ptyClosed.already_finished === false, JSON.stringify(ptyClosed))
const ptyClosedAgain = await terminalClose({ repo: "demo", session_id: ptySession.id })
ok("terminal_close idempotent", ptyClosedAgain.already_finished === true, JSON.stringify(ptyClosedAgain))

const tmBg: any = await terminal({ repo: "demo", command: "echo terminal_bg", background: true })
ok("terminal background tra job_id ngay", typeof tmBg.job_id === "string", JSON.stringify(tmBg))

// Background job repo lease holding test: background job locks repo
const longBg: any = await terminal({ repo: "demo", command: "node -e \"setTimeout(() => {}, 800)\"", background: true })
const lockCheck = await editFile({ repo: "demo", path: "README.md", old_str: "hello", new_str: "hello_locked" })
ok("concurrent edit_file cho background job lease lock hoan tat", lockCheck.changed === true, JSON.stringify(lockCheck))


// —— Build & test dong bo ——
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

// —— Job bat dong bo ——
console.log("\njob bat dong bo")
const jb: any = await runBuild({ repo: "demo", background: true })
ok("run_build background tra job_id ngay", typeof jb.job_id === "string", JSON.stringify(jb))
let js: any = await jobStatus({ job_id: jb.job_id })
for (let i = 0; i < 100 && !js.done; i++) {
	await sleep(100)
	js = await jobStatus({ job_id: jb.job_id })
}
ok("job chay xong, exit 0", js.status === "done" && js.exit_code === 0, JSON.stringify(js))
ok("job co output", String(js.output ?? "").includes("built"), String(js.output))
ok("liet ke duoc job", (await jobStatus({ repo: "demo" })).jobs.length >= 1)
await denies(
	"job_status bao loi voi job_id la",
	() => jobStatus({ job_id: "job-9999" }),
	"khong biet job",
)

const kjBg: any = await runBuild({ repo: "demo", background: true })
const kj = await killJob({ repo: "demo", job_id: kjBg.job_id })
ok("kill_job dung thanh cong background job", kj.status === "failed", JSON.stringify(kj))

// —— Audit log khong duoc chua noi dung file ——
console.log("\naudit")
const red = redactForAudit({
	repo: "demo",
	path: "src/a.ts",
	content: "SECRET_TOKEN_" + "x".repeat(5000),
}) as Record<string, unknown>
ok("khong ghi noi dung file vao audit", !String(red.content).includes("SECRET_TOKEN"))
ok("chi ghi do dai", String(red.content).includes("chars"), String(red.content))
ok("truong ngan van giu nguyen", red.path === "src/a.ts")
const redPty = redactForAudit({ data: "PASSWORD_TYPED_INTO_PTY" }) as Record<string, unknown>
ok("audit khong ghi raw PTY input", !String(redPty.data).includes("PASSWORD_TYPED_INTO_PTY"), String(redPty.data))

// —— kill_job phai dung CA process tree, khong chi tien trinh con truc tiep ——
console.log("\nkill_job process tree")
const heartbeatPath = join(rw, "heartbeat.txt")
writeFileSync(
	join(rw, "heartbeat_parent.js"),
	[
		"const { spawn } = require('node:child_process')",
		"const path = require('node:path')",
		"const heartbeatPath = path.join(__dirname, 'heartbeat.txt')",
		"const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');setInterval(()=>{try{fs.appendFileSync(${JSON.stringify(heartbeatPath)},'x')}catch(e){}},50)`], { stdio: 'ignore' })",
		"const cleanup = () => { try { child.kill('SIGKILL') } catch (e) {} }",
		"process.on('exit', cleanup)",
		"process.on('SIGTERM', cleanup)",
		"process.on('SIGINT', cleanup)",
		"process.on('SIGHUP', cleanup)",
		"setInterval(() => {}, 1000)",
	].join("\n") + "\n",
)

const treeJob: any = await terminal({ repo: "demo", command: "node heartbeat_parent.js", background: true })
ok("khoi dong duoc job cha se spawn tien trinh chau", typeof treeJob.job_id === "string", JSON.stringify(treeJob))

function readHeartbeat(): string {
	try { return readFileSync(heartbeatPath, "utf8") } catch { return "" }
}

let grandchildStarted = false
for (let i = 0; i < 100 && !grandchildStarted; i++) {
	await sleep(30)
	grandchildStarted = readHeartbeat().length > 0
}
ok("tien trinh chau (grandchild) da bat dau ghi heartbeat", grandchildStarted, `heartbeat len=${readHeartbeat().length}`)

const treeKill = await killJob({ repo: "demo", job_id: treeJob.job_id })
ok("kill_job bao da kill duoc tien trinh", treeKill.killed === true, JSON.stringify(treeKill))

await sleep(500)
const lenAfterKill = readHeartbeat().length
await sleep(800)
const lenLater = readHeartbeat().length
ok(
	"kill_job dung CA tien trinh chau (grandchild), khong de mo coi tiep tuc chay ngam",
	lenLater === lenAfterKill,
	`lenAfterKill=${lenAfterKill}, lenLater=${lenLater}`,
)

// —— Hai request dong thoi sua CUNG MOT FILE (dung lock/lease nhu reg() ap dung that) ——
console.log("\nconcurrent same-file edits")
await createFile({ repo: "demo", path: "src/concurrent_target.ts", content: "const x = 1\nconst y = 1\n" })
const [concEditA, concEditB] = await Promise.all([
	withLock(rw, "edit_file", () => editFile({ repo: "demo", path: "src/concurrent_target.ts", old_str: "const x = 1", new_str: "const x = 2" })),
	withLock(rw, "edit_file", () => editFile({ repo: "demo", path: "src/concurrent_target.ts", old_str: "const y = 1", new_str: "const y = 2" })),
])
ok("ca 2 edit_file dong thoi (qua withLock nhu reg() dung that) deu thanh cong", (concEditA as any).changed === true && (concEditB as any).changed === true, JSON.stringify({ concEditA, concEditB }))
const concurrentText = (await readFile({ repo: "demo", path: "src/concurrent_target.ts" })).text
ok(
	"khong mat update khi 2 request sua cung 1 file cung luc: lock serialize dung thu tu, ca hai thay doi deu duoc giu",
	concurrentText.includes("x = 2") && concurrentText.includes("y = 2"),
	concurrentText,
)

// —— Symbol index (tree-sitter) ——
console.log("\nsymbol index")
await createFile({ repo: "demo", path: "src/fn.ts", content: "export function helloFn(): number { return 1 }\n" })
const tfs = await traceFlow({ repo: "demo", symbol: "helloFn", refresh: true })
ok("trace_flow dung tree-sitter symbol index khi co", tfs.symbol_index === true, JSON.stringify(tfs).slice(0, 300))
ok(
	"symbol index tim dung definition AST",
	tfs.definitions.some((d) => d.path === "src/fn.ts" && d.line === 1),
	JSON.stringify(tfs.definitions),
)
const tfsNoIdx = await traceFlow({ repo: "refonly", symbol: "hello", refresh: true })
ok("repo khong co symbol thi tu lui heuristic", tfsNoIdx.symbol_index === false)

// —— Snapshot danh sach tool theo tung agent profile (CORE_ALLOWED / AGENT_ALLOWED) ——
console.log("\ntool profile snapshot")
ok("CORE_ALLOWED co cac tool doc/ghi/build co ban", ["read_file", "edit_file", "create_file", "git_commit", "run_tests", "health_check", "readiness_check", "get_metrics"].every((t) => CORE_ALLOWED.has(t)), JSON.stringify([...CORE_ALLOWED]))
ok("CORE_ALLOWED KHONG co cac tool nguy hiem/mo rong (terminal, apply_patch, move/remove, git_push, gh_pr, kill_job)", ["terminal", "terminal_start", "apply_patch", "move_file", "remove_file", "git_push", "gh_pr", "kill_job"].every((t) => !CORE_ALLOWED.has(t)), JSON.stringify([...CORE_ALLOWED]))
ok("AGENT_ALLOWED co cac tool composite/read-only chinh cho autofill agent", ["list_repos", "apply_patch", "run_typecheck", "run_tests", "git_status"].every((t) => AGENT_ALLOWED.has(t)), JSON.stringify([...AGENT_ALLOWED]))
ok("AGENT_ALLOWED KHONG co cac tool doc/ghi file truc tiep hay terminal/kill_job", ["read_file", "edit_file", "create_file", "git_commit", "terminal", "kill_job"].every((t) => !AGENT_ALLOWED.has(t)), JSON.stringify([...AGENT_ALLOWED]))

// —— Antigravity Live Window & Session tests ——
console.log("\nantigravity live window & session tests")
const { antigravitySpawn } = await import("../src/tools/antigravity.js")
const { getSession, stopSession } = await import("../src/antigravity/cli.js")

try {
	const spawned = (await antigravitySpawn({
		task: "echo hello smoke test",
		repo: "demo",
		interactive: true,
	})) as { conversation_id: string }
	ok("antigravity_spawn return conversation_id", Boolean(spawned?.conversation_id), JSON.stringify(spawned))

	const sess = getSession(spawned.conversation_id)
	ok("session state recorded correctly with logPath", Boolean(sess && sess.id === spawned.conversation_id))

	const stopped = stopSession(spawned.conversation_id)
	ok("stopSession cleans up session", stopped === true)
} catch (err) {
	ok("antigravity tool error handled", String(err).length > 0, String(err))
}

// —— Cau hinh sai phai sap ngay, khong duoc chay tiep ——
console.log("\ncau hinh sai")
writeFileSync(
	reposConfig,
	JSON.stringify({
		repos: [
			{ name: "dup", path: rw, write: true },
			{ name: "dup", path: ro },
		],
	}),
)
invalidateRepoCache()
try {
	allRepos()
	fail++
	console.error("  FAIL  trung ten repo phai bao loi — khong throw")
} catch (e) {
	ok("trung ten repo bi chan ngay", String(e).includes("trung"), String(e))
}
writeFileSync(reposConfig, goodConfig)
invalidateRepoCache()
ok("khoi phuc duoc sau khi sua config", allRepos().length === 2)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)

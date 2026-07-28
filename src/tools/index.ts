import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { withLock } from "../lock.js"
import { audit } from "../log.js"
import { resolveRepo } from "../repos.js"
import { createFile, createFileSchema } from "./createFile.js"
import { applyPatch, applyPatchSchema } from "./applyPatch.js"
import { editFile, editFileSchema } from "./editFile.js"
import { multiEditFile, multiEditFileSchema } from "./multiEditFile.js"
import { ghPr, ghPrSchema } from "./ghPr.js"
import { gitBlame, gitBlameSchema } from "./gitBlame.js"
import { gitBranch, gitBranchSchema } from "./gitBranch.js"
import { gitCommit, gitCommitSchema } from "./gitCommit.js"
import { gitDiff, gitDiffSchema } from "./gitDiff.js"
import { gitLog, gitLogSchema } from "./gitLog.js"
import { gitPush, gitPushSchema } from "./gitPush.js"
import { gitRestore, gitRestoreSchema } from "./gitRestore.js"
import { gitStash, gitStashSchema } from "./gitStash.js"
import { gitStatus, gitStatusSchema } from "./gitStatus.js"
import { jobStatus, jobStatusSchema } from "./jobStatus.js"
import { killJob, killJobSchema } from "./killJob.js"
import { listDir, listDirSchema } from "./listDir.js"
import { listRepos } from "./listRepos.js"
import { moveFile, moveFileSchema } from "./moveFile.js"
import { readManyFiles, readManyFilesSchema } from "./readManyFiles.js"
import { globFiles, globFilesSchema } from "./globFiles.js"
import { readFile, readFileSchema } from "./readFile.js"
import { reindex, reindexSchema } from "./reindex.js"
import { removeFile, removeFileSchema } from "./removeFile.js"
import { ripgrep, ripgrepSchema } from "./ripgrep.js"
import { runBuild, runBuildSchema, runTests, runTestsSchema } from "./runTests.js"
import { runLint, runLintSchema } from "./runLint.js"
import { runTypecheck, runTypecheckSchema } from "./runTypecheck.js"
import { terminal, terminalSchema } from "./terminal.js"

type Handler = (args: any) => Promise<unknown>

type Opts = {
	/** Tool chi doc: khong lock, annotation readOnlyHint. */
	readOnly?: boolean
	/** Tool xoa du lieu: annotation destructiveHint. */
	destructive?: boolean
	/** Tool chay execution ngoai world: annotation openWorldHint. */
	openWorld?: boolean
}

/**
 * Khoa lock phai la repo DA RESOLVE, khong phai args.repo tho: neu chi co 1 repo
 * thi goi co `repo` va goi bo trong `repo` tro cung mot repo — dung args tho se
 * tao 2 lane khac nhau va mat tac dung serialize.
 */
function lockKey(args: any): string {
	try {
		return resolveRepo(args?.repo).root
	} catch {
		return "<unresolved>" // handler se throw ngay sau day voi message ro rang
	}
}

import { TOOL_PROFILE } from "../config.js"

function reg(
	s: McpServer,
	name: string,
	desc: string,
	schema: any,
	fn: Handler,
	opts: Opts = {},
) {
	if (TOOL_PROFILE === "safe" && (opts.destructive || opts.openWorld || name === "git_push")) {
		return
	}
	if (TOOL_PROFILE === "core") {
		const coreAllowed = new Set([
			"list_repos",
			"read_file",
			"read_many_files",
			"list_dir",
			"glob_files",
			"ripgrep",
			"edit_file",
			"multi_edit_file",
			"create_file",
			"run_build",
			"run_tests",
			"run_lint",
			"run_typecheck",
			"job_status",
			"git_status",
			"git_diff",
			"git_log",
			"git_branch",
			"git_commit",
			"reindex",
		])
		if (!coreAllowed.has(name)) return
	}

	const readOnly = opts.readOnly ?? false

	s.registerTool(
		name,
		{
			description: desc,
			inputSchema: schema,
			annotations: {
				readOnlyHint: readOnly,
				destructiveHint: opts.destructive ?? false,
				idempotentHint: false,
				openWorldHint: opts.openWorld ?? false,
			},
		},
		async (args: any) => {
			const exec = async () => fn(args ?? {})
			try {
				// Tool co side effect duoc serialize theo tung repo de tranh race.
				const out = readOnly ? await exec() : await withLock(lockKey(args), name, exec)
				audit(name, args, true)
				return {
					content: [{ type: "text" as const, text: JSON.stringify(out) }],
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				audit(name, args, false, msg)
				// Tra loi duoi dang isError de agent doc duoc va tu sua, thay vi vo transport.
				return {
					isError: true,
					content: [{ type: "text" as const, text: `${name} failed: ${msg}` }],
				}
			}
		},
	)
}

export function registerAll(s: McpServer) {
	// —— Kham pha ——
	reg(s, "list_repos", "Liet ke cac repo server dang phuc vu, kem quyen ghi, branch prefix va toolchain. GOI TOOL NAY TRUOC TIEN: moi tool khac nhan tham so `repo` la ten lay tu day.", { refresh: z.boolean().optional().describe("Bo qua cache 10s, quet lai") }, listRepos, { readOnly: true })

	// —— Doc ——
	reg(s, "read_file", "Doc file trong mot repo, phan trang theo dong. Dung cho moi file khong nam trong code graph (markup, project file, CI yaml, config). Tu choi file binary va file qua lon.", readFileSchema, readFile, { readOnly: true })
	reg(s, "read_many_files", "Doc NHIEU FILE trong mot repo trong 1 lan goi duy nhat (1-50 files). Giup giam round-trip khi can doc nhieu file truoc khi refactor.", readManyFilesSchema, readManyFiles, { readOnly: true })
	reg(s, "list_dir", "Liet ke file/thu muc trong repo. Bo qua .git, node_modules, bin, obj, dist, target, .venv.", listDirSchema, listDir, { readOnly: true })
	reg(s, "glob_files", "Tim kiem file theo glob patterns (vd: **/*.ts). Tu dong su dung ripgrep hoac git ls-files. Uu tien dung tool nay de tim file theo pattern thay vi list_dir de quy.", globFilesSchema, globFiles, { readOnly: true })
	reg(s, "ripgrep", "Tim CHUOI VAN BAN tho bang regex trong mot repo, hoac trong TAT CA repo voi all_repos=true. Dung cho thu khong nam trong code graph: yaml, project file, config, chuoi log. Cau hoi ve symbol (ai goi ai, sua day thi vo dau) thi hoi code graph, dung tool nay se sot. Tu lui ve git grep neu may chua cai ripgrep.", ripgrepSchema, ripgrep, { readOnly: true })

	// —— Sua file (chi repo co write: true) ——
	reg(s, "edit_file", "Sua file da ton tai bang string-replace 1 vi tri. CHU Y: Neu can sua nhieu vi tri trong file, KHONG GOI NHOI NHOI tool nay nhieu lan, hay dung multi_edit_file de sua tat ca trong 1 lan goi duy nhat.", editFileSchema, editFile)
	reg(s, "multi_edit_file", "Sua NHIEU VI TRI trong 1 file trong 1 LAN GOI DUY NHAT (nguyen tu: all-or-nothing). Nhan mang edits: [{ old_str, new_str, replace_all? }]. Nhan expected_sha256 de chong troi troot code.", multiEditFileSchema, multiEditFile)
	reg(s, "apply_patch", "Ap dung mot patch gom nhieu hunk hoac nhieu file (Add, Update, Move, Delete) trong mot thao tac duy nhat. Pre-validate toan bo patch tren RAM truoc khi ghi. Dung edit_file cho 1 thay doi nho va multi_edit_file cho nhieu thay doi trong 1 file.", applyPatchSchema, applyPatch, { destructive: true })
	reg(s, "create_file", "Tao file MOI voi noi dung day du. Bao loi neu file da ton tai (sua file cu thi dung edit_file). Dung khi tach class/module ra file rieng.", createFileSchema, createFile)
	reg(s, "move_file", "Doi ten / di chuyen file bang git mv, giu history va blame. Khong di chuyen cheo repo.", moveFileSchema, moveFile)
	reg(s, "remove_file", "Xoa file da track bang git rm. Chi dung khi da chac khong con reference nao (kiem tra bang code graph hoac ripgrep truoc).", removeFileSchema, removeFile, { destructive: true })
	reg(s, "git_restore", "Duong lui: tra tung FILE cu the ve trang thai da commit (HEAD), bo thay doi chua commit cua chinh no. Dung khi sua sai. Chi nhan duong dan file cu the, khong nhan \".\" hay wildcard.", gitRestoreSchema, gitRestore, { destructive: true })

	// —— Verify & Quality ——
	reg(s, "run_build", "Chay lenh build cua repo (khai bao trong repos.json, hoac doan tu toolchain). Khong nhan argv tuy y. Repo lon nen dat background=true roi hoi bang job_status.", runBuildSchema, runBuild)
	reg(s, "run_tests", "Chay lenh test cua repo. Tuy chon filter (chi toolchain dotnet). Repo lon nen dat background=true roi hoi bang job_status.", runTestsSchema, runTests)
	reg(s, "run_lint", "Chay linter cua repo (eslint, dotnet format, cargo clippy, ruff, golangci-lint). Tuy chon fix=true de auto-fix neu toolchain ho tro.", runLintSchema, runLint)
	reg(s, "run_typecheck", "Chay kiem tra kieu (tsc --noEmit, mypy, cargo check, dotnet build --no-incremental).", runTypecheckSchema, runTypecheck)
	reg(s, "job_status", "Hoi ket qua job do run_build/run_tests/run_lint/run_typecheck hoac reindex tu dong sau commit tao ra. Bo trong job_id de xem danh sach job gan day.", jobStatusSchema, jobStatus, { readOnly: true })
	reg(s, "kill_job", "Huy/dung ngay mot background job dang chay (dieu kien qua job_id, vd: job-1). Dung khi lenh chay qua lau hoac bi lap vo tan.", killJobSchema, killJob, { destructive: true })

	// —— Git & PR ——
	reg(s, "git_status", "git status --porcelain + branch hien tai + repo nay co dang ghi duoc khong.", gitStatusSchema, gitStatus, { readOnly: true })
	reg(s, "git_branch", "Liet ke, tao hoac chuyen sang branch moi (`git checkout -b` / `git checkout`). Enforces branchPrefix khi tao branch.", gitBranchSchema, gitBranch)
	reg(s, "git_stash", "Quan ly stash working tree (push / pop / list).", gitStashSchema, gitStash)
	reg(s, "git_diff", "Xem diff working tree hoac staged, tuy chon gioi han theo path hoac chi --stat.", gitDiffSchema, gitDiff, { readOnly: true })
	reg(s, "git_log", "Lich su commit gan day, tuy chon gioi han theo path va kem --stat.", gitLogSchema, gitLog, { readOnly: true })
	reg(s, "git_blame", "git blame 1 file, tuy chon gioi han theo khoang dong. Dung de biet ai/commit nao doi dong code.", gitBlameSchema, gitBlame, { readOnly: true })
	reg(s, "git_commit", "Commit trong mot repo. Mac dinh CHI stage nhung file ma cac tool nay da sua, khong dung den thay doi nguoi dung tu lam do trong cung repo — dat all=true neu that su muon gom het. Tu choi commit neu co file thuoc deny-list (.env, key, secrets/) dang cho. Commit xong tu chay lai index code graph o background va tra ve reindex_job. Chi tren repo co quyen ghi va branch dung prefix.", gitCommitSchema, gitCommit)
	reg(s, "git_push", "Push branch hien tai len remote (--set-upstream, khong bao gio --force). Yeu cau working tree sach va ALLOW_PUSH=true.", gitPushSchema, gitPush)
	reg(s, "gh_pr", "Quan ly GitHub Pull Request qua GitHub CLI (`gh pr status`, `gh pr list`, `gh pr view`, `gh pr create`).", ghPrSchema, ghPr)
	reg(s, "terminal", "Chay lenh terminal theo chuoi command qua shell cua OS. CHI DUNG KHI ban that su muon agent co quyen chay lenh bat ky tren may nay. Mac dinh tool bi tat bang ALLOW_TERMINAL=false. Dung list_repos de chon repo lam cwd. Can vo cung can than: lenh co the doc secret, xoa file, hay thay doi he thong.", terminalSchema, terminal, { destructive: true, openWorld: true })

	// —— Code graph ——
	reg(s, "reindex", "Chay lai lenh index code graph cua repo (mac dinh: npx gitnexus analyze). git_commit da tu goi viec nay, nen chi can dung tay khi sua file ma CHUA commit va muon query graph ngay.", reindexSchema, reindex)
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { TOOL_PROFILE } from "../config.js"
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
import {
	terminalClose, terminalCloseSchema,
	terminalList, terminalListSchema,
	terminalRead, terminalReadSchema,
	terminalResize, terminalResizeSchema,
	terminalStart, terminalStartSchema,
	terminalWaitFor, terminalWaitForSchema,
	terminalWrite, terminalWriteSchema,
} from "./pty.js"
import { healthCheck, healthCheckSchema, readinessCheck, readinessCheckSchema } from "./healthCheck.js"
import { getMetrics, getMetricsSchema } from "./getMetrics.js"
import {
	antigravityList, antigravityListSchema,
	antigravityPoll, antigravityPollSchema,
	antigravityReply, antigravityReplySchema,
	antigravitySpawn, antigravitySpawnSchema,
	antigravityStop, antigravityStopSchema,
} from "./antigravity.js"
import { recordToolCall } from "../metrics.js"

type Handler = (args: any) => Promise<unknown>
type Opts = {
	readOnly?: boolean
	destructive?: boolean
	openWorld?: boolean
	/** Handler creates a job that owns the repo lease; do not acquire an outer lease. */
	managesOwnLease?: boolean
}

function lockKey(args: any): string {
	try {
		return resolveRepo(args?.repo).root
	} catch {
		return "<unresolved>"
	}
}

export const CORE_ALLOWED = new Set([
	"list_repos", "read_file", "read_many_files", "list_dir", "glob_files", "ripgrep",
	"edit_file", "multi_edit_file", "create_file", "run_build", "run_tests", "run_lint",
	"run_typecheck", "job_status", "git_status", "git_diff", "git_log", "git_branch",
	"git_commit", "terminal_wait_for", "antigravity_spawn", "antigravity_poll",
	"antigravity_reply", "antigravity_stop", "antigravity_list",
	"health_check", "readiness_check", "get_metrics",
])
export const AGENT_ALLOWED = new Set([
	"list_repos", "apply_patch", "run_typecheck", "run_tests", "git_status",
	"git_diff", "antigravity_spawn", "antigravity_poll", "antigravity_reply",
])

function reg(s: McpServer, name: string, desc: string, schema: any, fn: Handler, opts: Opts = {}) {
	if (TOOL_PROFILE === "safe" && (opts.destructive || opts.openWorld || name === "git_push")) return
	if (TOOL_PROFILE === "core" && !CORE_ALLOWED.has(name)) return
	if (TOOL_PROFILE === "agent" && !AGENT_ALLOWED.has(name)) return
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
			const t0 = Date.now()
			const exec = async () => fn(args ?? {})
			try {
				const out = readOnly || opts.managesOwnLease
					? await exec()
					: await withLock(lockKey(args), name, exec)
				audit(name, args, true)
				recordToolCall(name, Date.now() - t0, true)
				return { content: [{ type: "text" as const, text: JSON.stringify(out) }] }
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				audit(name, args, false, msg)
				recordToolCall(name, Date.now() - t0, false, msg)
				return { isError: true, content: [{ type: "text" as const, text: `${name} failed: ${msg}` }] }
			}
		},
	)
}

export function registerAll(s: McpServer) {
	reg(s, "list_repos", "GOI TRUOC TIEN KHI CHUA BIET TEN REPO: Liet ke danh sach repo server dang phuc vu, quyen ghi (write=true/false) va toolchain. Moi tool khac can tham so `repo` la ten lay tu day.", { refresh: z.boolean().optional().describe("Bo qua cache 10s, quet lai") }, listRepos, { readOnly: true })
	reg(s, "read_file", "Doc 1 file cu the trong repo khi DA BIET CHINH XAC DUONG DAN (config, source code, markdown). Phan trang theo dong.", readFileSchema, readFile, { readOnly: true })
	reg(s, "read_many_files", "Doc TU 1 DEN 50 FILE cung mot luc trong 1 call duy nhat. Dung khi can xem nhieu file nguon truoc khi refactor de giam round-trip.", readManyFilesSchema, readManyFiles, { readOnly: true })
	reg(s, "list_dir", "Liet ke file/thu muc trong repo de xem cau truc cay thu muc. Bo qua node_modules, bin, obj, dist, .git.", listDirSchema, listDir, { readOnly: true })
	reg(s, "glob_files", "Tim kiem duong dan file theo mau pattern (vd: **/*.ts, src/**/*.json). Dung khi can tim vi tri file theo extension hoac thu muc.", globFilesSchema, globFiles, { readOnly: true })
	reg(s, "ripgrep", "Tim CHUOI VAN BAN / REGEX trong toan bo codebase (hoac trong tat ca repos voi all_repos=true). Dung de tim vi tri khai bao symbol hoac chuoi loi.", ripgrepSchema, ripgrep, { readOnly: true })
	reg(s, "edit_file", "Sua DUY NHAT 1 VI TRI trong 1 file da ton tai bang string-replace (old_str -> new_str). Nhanh va an toan cho chinh sua nho.", editFileSchema, editFile)
	reg(s, "multi_edit_file", "Sua NHIEU VI TRI KHONG LIEN TUC trong CUNG 1 FILE trong 1 call duy nhat (nguyen tu: atomic rollback neu 1 vi tri loi).", multiEditFileSchema, multiEditFile)
	reg(s, "apply_patch", "Ap dung unified diff patch de SUA NHIEU FILE / NHIEU KHOI CODE cung luc trong 1 thao tac duy nhat.", applyPatchSchema, applyPatch, { destructive: true })
	reg(s, "create_file", "Tao MOI 1 file hoan toan voi noi dung ban dau. Tu choi neu file da ton tai (khong ghi de).", createFileSchema, createFile)
	reg(s, "move_file", "Doi ten hoac di chuyen file bang git mv. Giu nguyen lich su git cua file.", moveFileSchema, moveFile)
	reg(s, "remove_file", "Xoa file da duoc git track bang git rm.", removeFileSchema, removeFile, { destructive: true })
	reg(s, "git_restore", "Hoan tac va tra 1 file cu the ve trang thai commit HEAD ban dau. Tu choi wildcard va thu muc.", gitRestoreSchema, gitRestore, { destructive: true })
	reg(s, "run_build", "Chay lenh build mac dinh cua repo (npm run build, dotnet build, cargo build...).", runBuildSchema, runBuild, { managesOwnLease: true })
	reg(s, "run_tests", "Chay bo test mac dinh cua repo (npm test, dotnet test...).", runTestsSchema, runTests, { managesOwnLease: true })
	reg(s, "run_lint", "Chay linter mac dinh cua repo (eslint, cargo clippy...).", runLintSchema, runLint, { managesOwnLease: true })
	reg(s, "run_typecheck", "Chay kiem tra kieu (tsc, mypy...).", runTypecheckSchema, runTypecheck, { managesOwnLease: true })
	reg(s, "job_status", "Hoi ket qua cua 1 background job (build/test chay ngam).", jobStatusSchema, jobStatus, { readOnly: true })
	reg(s, "kill_job", "Dung va giet ngay 1 background job dang chay ngam.", killJobSchema, killJob, { destructive: true, managesOwnLease: true })
	reg(s, "git_status", "Xem trang thai git working tree (dirty/clean), staged files va branch hien tai.", gitStatusSchema, gitStatus, { readOnly: true })
	reg(s, "git_branch", "Liet ke, tao moi hoac chuyen doi git branch trong repo.", gitBranchSchema, gitBranch)
	reg(s, "git_stash", "Luu tam (stash) hoac khoi phuc cac thay doi chua commit trong working tree.", gitStashSchema, gitStash)
	reg(s, "git_diff", "Xem noi dung thay doi (diff) cua working tree so voi HEAD hoac staged.", gitDiffSchema, gitDiff, { readOnly: true })
	reg(s, "git_log", "Xem lich su cac commit gan day trong branch hien tai.", gitLogSchema, gitLog, { readOnly: true })
	reg(s, "git_blame", "Xem nguoi commit va lich su chinh sua theo tung dong cua 1 file.", gitBlameSchema, gitBlame, { readOnly: true })
	reg(s, "git_commit", "Tao 1 git commit moi cho cac thay doi trong repo.", gitCommitSchema, gitCommit)
	reg(s, "git_push", "Push branch hien tai len git remote (khong cho force push).", gitPushSchema, gitPush)
	reg(s, "gh_pr", "Quan ly, tao hoac xem GitHub Pull Request qua GitHub CLI.", ghPrSchema, ghPr)
	reg(s, "terminal", "Chay 1 lenh terminal don le (stateless command) trong thu muc repo va tra ve output ngay.", terminalSchema, terminal, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_start", "Mo 1 phien Shell PTY tuong tac keo dai (stateful PTY session) de chay cac lenh dai han.", terminalStartSchema, terminalStart, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_write", "Gui raw input/phim bam (Enter, Ctrl+C...) vao PTY session dang chay.", terminalWriteSchema, terminalWrite, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_read", "Doc luong output moi tu PTY session bang byte cursor (khong lap lai output cu).", terminalReadSchema, terminalRead, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_wait_for", "Cho 1 chuoi/regex xuat hien trong output cua PTY session (long-poll trong 1 call).", terminalWaitForSchema, terminalWaitFor, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_resize", "Doi kich thuoc man hinh PTY session.", terminalResizeSchema, terminalResize, { openWorld: true, managesOwnLease: true })
	reg(s, "terminal_close", "Dong va dung phien PTY session.", terminalCloseSchema, terminalClose, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_list", "Liet ke cac phien PTY session dang mo va trang thai.", terminalListSchema, terminalList, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "reindex", "Chay lai lenh reindex cua repo.", reindexSchema, reindex)
	reg(s, "antigravity_spawn", "UU TIEN CHO TAC VU PHUC TAP, REFACTOR NHIEU FILE, DIEU TRA CODEBASE HOAC CONG VIEC NHIEU BUOC. Khoi chay Antigravity Sub-agent trong background va hien thi Live Viewer cho nguoi dung. Sau khi goi, BAT BUOC dung antigravity_poll den khi done=true. Tac vu can chay lenh hoac sua file phai dat skip_permissions=true. Khong dung cho thao tac don gian ma tool truc tiep xu ly nhanh hon.", antigravitySpawnSchema, antigravitySpawn, { openWorld: true, managesOwnLease: true })
	reg(s, "antigravity_poll", "Doc tien do va NOI DUNG CAU TRA LOI (response) tu Sub-agent Antigravity. Khi done=true, doc truong text/response; neu can tiep tuc hoi thoai, goi antigravity_reply voi cung conversation_id.", antigravityPollSchema, antigravityPoll, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "antigravity_reply", "Gui 1 luot hoi thoai tiep theo vao phien Antigravity cu (--conversation) khi luot truoc da done=true.", antigravityReplySchema, antigravityReply, { openWorld: true, managesOwnLease: true })
	reg(s, "antigravity_stop", "Dung ngay 1 Sub-agent Antigravity dang chay.", antigravityStopSchema, antigravityStop, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "antigravity_list", "Liet ke cac phien Sub-agent Antigravity dang hoat dong.", antigravityListSchema, antigravityList, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "health_check", "Kiem tra liveness cua server (uptime, PID, Node version).", healthCheckSchema, healthCheck, { readOnly: true })
	reg(s, "readiness_check", "Kiem tra readiness cua server (config, repo registry validity).", readinessCheckSchema, readinessCheck, { readOnly: true })
	reg(s, "get_metrics", "Lay thong ke metrics (so luong tool call, thoi gian thuc thi, PTY sessions).", getMetricsSchema, getMetrics, { readOnly: true })
}

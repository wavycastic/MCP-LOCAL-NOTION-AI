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
import { featureContext, featureContextSchema } from "./featureContext.js"
import { traceFlow, traceFlowSchema } from "./traceFlow.js"
import { analyzeFeature, analyzeFeatureSchema } from "./analyzeFeature.js"
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
	"get_feature_context", "trace_flow", "analyze_feature",
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

type ToolDef = { name: string; desc: string; schema: any; fn: Handler; opts?: Opts }

/*
 * Bang mo ta tool dung chung, tao MOT lan luc load module.
 *
 * Truoc day registerAll tao lai toan bo object schema/closure/opts cho MOI HTTP
 * request (server stateless = 1 McpServer moi moi request). registerTool cua SDK
 * van phai chay lai tung request, nhung phan cap phat object JS thua thi khong
 * con — giam ap luc GC tren duong nong.
 */
const TOOL_DEFS: ToolDef[] = [
	{ name: "list_repos", desc: "Liet ke cac repo dang phuc vu (ten, quyen ghi, toolchain). Goi dau tien khi chua biet ten repo — moi tool khac nhan tham so `repo` tu day.", schema: { refresh: z.boolean().optional().describe("Bo qua cache 10s, quet lai") }, fn: listRepos, opts: { readOnly: true } },
	{ name: "read_file", desc: "Doc 1 file khi DA BIET chinh xac duong dan. Phan trang theo dong.", schema: readFileSchema, fn: readFile, opts: { readOnly: true } },
	{ name: "read_many_files", desc: "Doc 1-50 file trong 1 call de giam round-trip.", schema: readManyFilesSchema, fn: readManyFiles, opts: { readOnly: true } },
	{ name: "list_dir", desc: "Liet ke file/thu muc (bo qua node_modules, bin, obj, dist, .git).", schema: listDirSchema, fn: listDir, opts: { readOnly: true } },
	{ name: "glob_files", desc: "Tim duong dan file theo glob pattern (vd: **/*.ts, src/**/*.json).", schema: globFilesSchema, fn: globFiles, opts: { readOnly: true } },
	{ name: "ripgrep", desc: "Tim chuoi/regex trong codebase (all_repos=true: xuyen repo). De tim roi DOC LUON thi dung get_feature_context.", schema: ripgrepSchema, fn: ripgrep, opts: { readOnly: true } },
	{ name: "get_feature_context", desc: "Gop tim+doc vao 1 call: nhap query (symbol/ham/chuoi loi), tra ve cac file lien quan xep theo so match. detail: L0 chi liet ke, L1 (mac dinh) outline+doan quanh match, L2 nguyen file. Lan luong goi thi dung trace_flow; tong hop ca hai dung analyze_feature. Cache theo git HEAD; refresh=true khi vua sua code. Biet san file thi dung read_file.", schema: featureContextSchema, fn: featureContext, opts: { readOnly: true } },
	{ name: "trace_flow", desc: "Lan luong goi cua 1 symbol trong 1 call: dinh nghia (kem body), callers, callees (depth=2 lan them 1 tang, chi ten). Heuristic ripgrep, khong can LSP. Cache theo git HEAD. Can noi dung file thay vi luong goi thi dung get_feature_context.", schema: traceFlowSchema, fn: traceFlow, opts: { readOnly: true } },
	{ name: "analyze_feature", desc: "1 CALL DUY NHAT cho cau hoi ve 1 chuc nang: gop tim file lien quan (nhu get_feature_context L1) + lan luong goi cua symbol chinh (nhu trace_flow), chay song song. Truyen `symbol` ro rang neu biet; khong thi tu doan tu query (chi nhan ten co chu hoa). Dung cho 'tinh nang X chay the nao'.", schema: analyzeFeatureSchema, fn: analyzeFeature, opts: { readOnly: true } },
	{ name: "edit_file", desc: "Sua 1 vi tri trong file bang string-replace (old_str -> new_str). Response kem context ~11 dong quanh vet sua de verify ngay, khong can goi read_file lai.", schema: editFileSchema, fn: editFile },
	{ name: "multi_edit_file", desc: "Sua nhieu vi tri trong cung 1 file, nguyen tu (rollback neu 1 vi tri loi). Response kem context quanh vet sua dau tien.", schema: multiEditFileSchema, fn: multiEditFile },
	{ name: "apply_patch", desc: "Ap dung unified diff patch sua nhieu file cung luc (ho tro dry_run).", schema: applyPatchSchema, fn: applyPatch, opts: { destructive: true } },
	{ name: "create_file", desc: "Tao file moi (tu choi ghi de file da ton tai).", schema: createFileSchema, fn: createFile },
	{ name: "move_file", desc: "Doi ten hoac di chuyen file bang git mv. Giu nguyen lich su git cua file.", schema: moveFileSchema, fn: moveFile },
	{ name: "remove_file", desc: "Xoa file da duoc git track bang git rm.", schema: removeFileSchema, fn: removeFile, opts: { destructive: true } },
	{ name: "git_restore", desc: "Tra 1 file ve trang thai HEAD (khong nhan wildcard/thu muc).", schema: gitRestoreSchema, fn: gitRestore, opts: { destructive: true } },
	{ name: "run_build", desc: "Chay lenh build mac dinh cua repo (npm run build, dotnet build, cargo build...).", schema: runBuildSchema, fn: runBuild, opts: { managesOwnLease: true } },
	{ name: "run_tests", desc: "Chay bo test mac dinh cua repo (npm test, dotnet test...).", schema: runTestsSchema, fn: runTests, opts: { managesOwnLease: true } },
	{ name: "run_lint", desc: "Chay linter mac dinh cua repo (eslint, cargo clippy...).", schema: runLintSchema, fn: runLint, opts: { managesOwnLease: true } },
	{ name: "run_typecheck", desc: "Chay kiem tra kieu (tsc, mypy...).", schema: runTypecheckSchema, fn: runTypecheck, opts: { managesOwnLease: true } },
	{ name: "job_status", desc: "Hoi ket qua cua 1 background job (build/test chay ngam).", schema: jobStatusSchema, fn: jobStatus, opts: { readOnly: true } },
	{ name: "kill_job", desc: "Dung va giet ngay 1 background job dang chay ngam.", schema: killJobSchema, fn: killJob, opts: { destructive: true, managesOwnLease: true } },
	{ name: "git_status", desc: "Xem trang thai git working tree (dirty/clean), staged files va branch hien tai.", schema: gitStatusSchema, fn: gitStatus, opts: { readOnly: true } },
	{ name: "git_branch", desc: "Liet ke, tao moi hoac chuyen doi git branch trong repo.", schema: gitBranchSchema, fn: gitBranch },
	{ name: "git_stash", desc: "Luu tam (stash) hoac khoi phuc cac thay doi chua commit trong working tree.", schema: gitStashSchema, fn: gitStash },
	{ name: "git_diff", desc: "Xem noi dung thay doi (diff) cua working tree so voi HEAD hoac staged.", schema: gitDiffSchema, fn: gitDiff, opts: { readOnly: true } },
	{ name: "git_log", desc: "Xem lich su cac commit gan day trong branch hien tai.", schema: gitLogSchema, fn: gitLog, opts: { readOnly: true } },
	{ name: "git_blame", desc: "Xem nguoi commit va lich su chinh sua theo tung dong cua 1 file.", schema: gitBlameSchema, fn: gitBlame, opts: { readOnly: true } },
	{ name: "git_commit", desc: "Tao 1 git commit moi cho cac thay doi trong repo.", schema: gitCommitSchema, fn: gitCommit },
	{ name: "git_push", desc: "Push branch hien tai len git remote (khong cho force push).", schema: gitPushSchema, fn: gitPush },
	{ name: "gh_pr", desc: "Quan ly, tao hoac xem GitHub Pull Request qua GitHub CLI.", schema: ghPrSchema, fn: ghPr },
	{ name: "terminal", desc: "Chay 1 lenh terminal don le trong thu muc repo, tra output ngay.", schema: terminalSchema, fn: terminal, opts: { destructive: true, openWorld: true, managesOwnLease: true } },
	{ name: "terminal_start", desc: "Mo phien shell PTY tuong tac keo dai (stateful) cho lenh dai han.", schema: terminalStartSchema, fn: terminalStart, opts: { destructive: true, openWorld: true, managesOwnLease: true } },
	{ name: "terminal_write", desc: "Gui input/phim bam (Enter, Ctrl+C...) vao PTY session dang chay.", schema: terminalWriteSchema, fn: terminalWrite, opts: { destructive: true, openWorld: true, managesOwnLease: true } },
	{ name: "terminal_read", desc: "Doc output moi tu PTY session theo byte cursor (khong lap lai output cu).", schema: terminalReadSchema, fn: terminalRead, opts: { readOnly: true, openWorld: true, managesOwnLease: true } },
	{ name: "terminal_wait_for", desc: "Cho 1 chuoi/regex xuat hien trong output PTY session (long-poll).", schema: terminalWaitForSchema, fn: terminalWaitFor, opts: { readOnly: true, openWorld: true, managesOwnLease: true } },
	{ name: "terminal_resize", desc: "Doi kich thuoc man hinh PTY session.", schema: terminalResizeSchema, fn: terminalResize, opts: { openWorld: true, managesOwnLease: true } },
	{ name: "terminal_close", desc: "Dong va dung phien PTY session.", schema: terminalCloseSchema, fn: terminalClose, opts: { destructive: true, openWorld: true, managesOwnLease: true } },
	{ name: "terminal_list", desc: "Liet ke cac phien PTY session dang mo va trang thai.", schema: terminalListSchema, fn: terminalList, opts: { readOnly: true, openWorld: true, managesOwnLease: true } },
	{ name: "reindex", desc: "Ep build lai tree-sitter symbol index cua repo (bo qua moi cache). Index thuong tu invalidate theo repoStamp — chi can goi khi muon lam tuoi chu dong.", schema: reindexSchema, fn: reindex },
	{ name: "antigravity_spawn", desc: "UU TIEN cho tac vu phuc tap/nhieu buoc: khoi chay Antigravity sub-agent background. Sau khi goi BAT BUOC poll bang antigravity_poll toi khi done=true. Can chay lenh/ghi file thi dat skip_permissions=true. Khong dung cho thao tac don gian.", schema: antigravitySpawnSchema, fn: antigravitySpawn, opts: { openWorld: true, managesOwnLease: true } },
	{ name: "antigravity_poll", desc: "Doc tien do + cau tra loi cua sub-agent Antigravity; done=true thi doc text/response, tiep tuc hoi bang antigravity_reply.", schema: antigravityPollSchema, fn: antigravityPoll, opts: { readOnly: true, openWorld: true, managesOwnLease: true } },
	{ name: "antigravity_reply", desc: "Gui luot hoi thoai tiep theo vao phien Antigravity cu (cung conversation_id).", schema: antigravityReplySchema, fn: antigravityReply, opts: { openWorld: true, managesOwnLease: true } },
	{ name: "antigravity_stop", desc: "Dung ngay 1 Sub-agent Antigravity dang chay.", schema: antigravityStopSchema, fn: antigravityStop, opts: { destructive: true, openWorld: true, managesOwnLease: true } },
	{ name: "antigravity_list", desc: "Liet ke cac phien Sub-agent Antigravity dang hoat dong.", schema: antigravityListSchema, fn: antigravityList, opts: { readOnly: true, openWorld: true, managesOwnLease: true } },
	{ name: "health_check", desc: "Kiem tra liveness cua server (uptime, PID, Node version).", schema: healthCheckSchema, fn: healthCheck, opts: { readOnly: true } },
	{ name: "readiness_check", desc: "Kiem tra readiness cua server (config, repo registry validity).", schema: readinessCheckSchema, fn: readinessCheck, opts: { readOnly: true } },
	{ name: "get_metrics", desc: "Lay thong ke metrics (so luong tool call, thoi gian thuc thi, PTY sessions).", schema: getMetricsSchema, fn: getMetrics, opts: { readOnly: true } },
]

export function registerAll(s: McpServer) {
	for (const d of TOOL_DEFS) reg(s, d.name, d.desc, d.schema, d.fn, d.opts)
}

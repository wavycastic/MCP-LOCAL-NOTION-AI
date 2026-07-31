import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ALLOW_FLOWLENS, TOOL_PROFILE } from "../config.js"
import { withLock } from "../lock.js"
import { audit } from "../log.js"
import { resolveRepo } from "../repos.js"
import { syncFlowLensAfterTool } from "../flowlens.js"
import { canEdit, canEditSchema, explainSymbol, explainSymbolSchema, findReferences, findReferencesSchema, findSymbol, findSymbolSchema, indexFiles, indexFilesSchema, inspectCodebase, inspectCodebaseSchema, prepareChange, prepareChangeSchema, readContext, readContextSchema, repoOverview, repoOverviewSchema, searchCode, searchCodeSchema, traceFlow, traceFlowSchema, verifyChange, verifyChangeSchema, whatBreaks, whatBreaksSchema } from "./codeUnderstanding.js"
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

export const FLOWLENS_TOOLS = new Set([
	"repo_overview", "inspect_codebase", "index_files", "find_symbol",
	"explain_symbol", "find_references", "trace_flow", "what_breaks",
	"search_code", "prepare_change", "can_edit", "verify_change", "reindex",
])
export const CORE_ALLOWED = new Set([
	"list_repos", "read_file", "read_many_files", "list_dir", "glob_files", "ripgrep",
	"edit_file", "multi_edit_file", "create_file", "run_build", "run_tests", "run_lint",
	"run_typecheck", "job_status", "git_status", "git_diff", "git_log", "git_branch",
	"git_commit", "reindex", "terminal_wait_for",
	"repo_overview", "inspect_codebase", "read_context", "index_files",
	"find_symbol", "explain_symbol", "find_references", "trace_flow",
	"what_breaks", "search_code", "prepare_change", "can_edit", "verify_change",
	"health_check", "readiness_check", "get_metrics",
])
export const AGENT_ALLOWED = new Set(["list_repos", "repo_overview", "inspect_codebase", "explain_symbol", "trace_flow", "read_context", "apply_patch", "what_breaks", "run_typecheck", "run_tests", "git_status", "search_code", "prepare_change", "can_edit", "verify_change"])

function reg(s: McpServer, name: string, desc: string, schema: any, fn: Handler, opts: Opts = {}) {
	if (!ALLOW_FLOWLENS && FLOWLENS_TOOLS.has(name)) return
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
				const repo = readOnly ? undefined : resolveRepo(args?.repo)
				const flowlensIndex = repo ? await syncFlowLensAfterTool(repo, name, out) : undefined
				const response = flowlensIndex && out && typeof out === "object"
					? { ...(out as Record<string, unknown>), flowlens_index: flowlensIndex }
					: out
				audit(name, args, true)
				recordToolCall(name, Date.now() - t0, true)
				return { content: [{ type: "text" as const, text: JSON.stringify(response) }] }
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
	reg(s, "list_repos", "Liet ke cac repo server dang phuc vu, kem quyen ghi, branch prefix va toolchain. GOI TOOL NAY TRUOC TIEN: moi tool khac nhan tham so `repo` la ten lay tu day.", { refresh: z.boolean().optional().describe("Bo qua cache 10s, quet lai") }, listRepos, { readOnly: true })
	reg(s, "read_file", "Doc file trong mot repo, phan trang theo dong. Dung cho moi file khong nam trong code graph (markup, project file, CI yaml, config). Tu choi file binary va file qua lon.", readFileSchema, readFile, { readOnly: true })
	reg(s, "read_many_files", "Doc NHIEU FILE trong mot repo trong 1 lan goi duy nhat (1-50 files). Giup giam round-trip khi can doc nhieu file truoc khi refactor.", readManyFilesSchema, readManyFiles, { readOnly: true })
	reg(s, "list_dir", "Liet ke file/thu muc trong repo. Bo qua .git, node_modules, bin, obj, dist, target, .venv.", listDirSchema, listDir, { readOnly: true })
	reg(s, "glob_files", "Tim kiem file theo glob patterns (vd: **/*.ts). Tu dong su dung ripgrep hoac git ls-files.", globFilesSchema, globFiles, { readOnly: true })
	reg(s, "ripgrep", "Tim CHUOI VAN BAN tho bang regex trong mot repo, hoac trong TAT CA repo voi all_repos=true.", ripgrepSchema, ripgrep, { readOnly: true })
	reg(s, "repo_overview", "Tong quan co cau truc tu FlowLens: stack, module, entry point, API, integration, test, command, critical flow va index freshness.", repoOverviewSchema, repoOverview, { readOnly: true })
	reg(s, "inspect_codebase", "Composite code understanding: search, symbol/route, graph expansion, rerank va context packing trong mot call.", inspectCodebaseSchema, inspectCodebase, { readOnly: true })
	reg(s, "read_context", "Doc cac source range, tu gop overlap, giu line, gioi han byte/file, tra SHA va phan bi bo.", readContextSchema, readContext, { readOnly: true })
	reg(s, "index_files", "Khoi tao hoac cap nhat incremental SQLite FTS5 FlowLens cho repo. Truyen changed_files sau write.", indexFilesSchema, indexFiles)
	reg(s, "find_symbol", "Tim workspace/document symbol chinh xac bang TypeScript/JavaScript language service.", findSymbolSchema, findSymbol, { readOnly: true })
	reg(s, "explain_symbol", "Giai thich symbol bang LSP: definition, hover/type, references, diagnostics, rename preview va code actions.", explainSymbolSchema, explainSymbol, { readOnly: true })
	reg(s, "find_references", "Tim references chinh xac bang language service, gom definition va write-access metadata.", findReferencesSchema, findReferences, { readOnly: true })
	reg(s, "trace_flow", "Trace execution flow qua graph tu symbol nguon den dich, hoac downstream co gioi han.", traceFlowSchema, traceFlow, { readOnly: true })
	reg(s, "what_breaks", "Phan tich blast radius upstream/downstream, related tests va unknowns tu FlowLens graph.", whatBreaksSchema, whatBreaks, { readOnly: true })
	reg(s, "search_code", "Tim kiem multi-channel (FTS, graph, semantic) trong codebase qua FlowLens: tra ve context pack, symbols, routes co lien quan.", searchCodeSchema, searchCode, { readOnly: true })
	reg(s, "prepare_change", "Lap ke hoach thay doi: FlowLens tim entry point, impact graph, required reads va test scope cho intent.", prepareChangeSchema, prepareChange, { readOnly: true })
	reg(s, "can_edit", "Kiem tra an toan va co the chinh sua file/symbol cu the: tra ve risk level, contracts can kiem tra va dieu kien tien quyet.", canEditSchema, canEdit, { readOnly: true })
	reg(s, "verify_change", "Xac nhan thay doi sau edit: so sanh diff voi plan, phat hien contract risks, verification checks va red flags.", verifyChangeSchema, verifyChange, { readOnly: true })
	reg(s, "edit_file", "Sua file da ton tai bang string-replace 1 vi tri.", editFileSchema, editFile)
	reg(s, "multi_edit_file", "Sua NHIEU VI TRI trong 1 file trong 1 LAN GOI DUY NHAT (nguyen tu: all-or-nothing).", multiEditFileSchema, multiEditFile)
	reg(s, "apply_patch", "Ap dung patch nhieu hunk/file trong mot thao tac duy nhat.", applyPatchSchema, applyPatch, { destructive: true })
	reg(s, "create_file", "Tao file MOI voi noi dung day du.", createFileSchema, createFile)
	reg(s, "move_file", "Doi ten / di chuyen file bang git mv.", moveFileSchema, moveFile)
	reg(s, "remove_file", "Xoa file da track bang git rm.", removeFileSchema, removeFile, { destructive: true })
	reg(s, "git_restore", "Tra tung file cu the ve trang thai HEAD.", gitRestoreSchema, gitRestore, { destructive: true })
	reg(s, "run_build", "Chay lenh build cua repo.", runBuildSchema, runBuild, { managesOwnLease: true })
	reg(s, "run_tests", "Chay lenh test cua repo.", runTestsSchema, runTests, { managesOwnLease: true })
	reg(s, "run_lint", "Chay linter cua repo.", runLintSchema, runLint, { managesOwnLease: true })
	reg(s, "run_typecheck", "Chay kiem tra kieu.", runTypecheckSchema, runTypecheck, { managesOwnLease: true })
	reg(s, "job_status", "Hoi ket qua background job.", jobStatusSchema, jobStatus, { readOnly: true })
	reg(s, "kill_job", "Huy/dung ngay mot background job.", killJobSchema, killJob, { destructive: true, managesOwnLease: true })
	reg(s, "git_status", "git status va branch hien tai.", gitStatusSchema, gitStatus, { readOnly: true })
	reg(s, "git_branch", "Liet ke, tao hoac chuyen branch.", gitBranchSchema, gitBranch)
	reg(s, "git_stash", "Quan ly stash working tree.", gitStashSchema, gitStash)
	reg(s, "git_diff", "Xem diff working tree hoac staged.", gitDiffSchema, gitDiff, { readOnly: true })
	reg(s, "git_log", "Lich su commit gan day.", gitLogSchema, gitLog, { readOnly: true })
	reg(s, "git_blame", "git blame mot file.", gitBlameSchema, gitBlame, { readOnly: true })
	reg(s, "git_commit", "Commit trong mot repo va tuy chon reindex.", gitCommitSchema, gitCommit)
	reg(s, "git_push", "Push branch hien tai len remote, khong force.", gitPushSchema, gitPush)
	reg(s, "gh_pr", "Quan ly GitHub Pull Request qua GitHub CLI.", ghPrSchema, ghPr)
	reg(s, "terminal", "Chay lenh terminal theo chuoi command qua shell cua OS.", terminalSchema, terminal, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_start", "Mo interactive PTY session. Bo command de mo shell; session ton tai qua nhieu MCP calls.", terminalStartSchema, terminalStart, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_write", "Gui raw input vao PTY session (\\r=Enter, \\x03=Ctrl+C).", terminalWriteSchema, terminalWrite, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_read", "Doc output PTY tang dan bang byte cursor, khong lap lai output cu. Ho tro wait_ms long-poll va mode=text de strip ANSI.", terminalReadSchema, terminalRead, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_wait_for", "Cho chuoi/regex xuat hien trong PTY output (long-poll trong 1 call). Thay the polling loop thu cong.", terminalWaitForSchema, terminalWaitFor, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_resize", "Doi kich thuoc PTY/ConPTY session.", terminalResizeSchema, terminalResize, { openWorld: true, managesOwnLease: true })
	reg(s, "terminal_close", "Dong va kill PTY session.", terminalCloseSchema, terminalClose, { destructive: true, openWorld: true, managesOwnLease: true })
	reg(s, "terminal_list", "Liet ke PTY sessions va trang thai, khong tra command/input raw.", terminalListSchema, terminalList, { readOnly: true, openWorld: true, managesOwnLease: true })
	reg(s, "reindex", "Chay lai lenh index code graph cua repo.", reindexSchema, reindex)
	reg(s, "health_check", "Kiem tra process con song: tra uptime, PID va Node version. Khong tiet lo config nhay cam.", healthCheckSchema, healthCheck, { readOnly: true })
	reg(s, "readiness_check", "Kiem tra readiness: config hop le, repo registry, git validity va FlowLens sidecar status.", readinessCheckSchema, readinessCheck, { readOnly: true })
	reg(s, "get_metrics", "Lay metrics: tool call counts, durations, FlowLens sidecar timeouts/crashes, PTY sessions va buffer drops.", getMetricsSchema, getMetrics, { readOnly: true })
}

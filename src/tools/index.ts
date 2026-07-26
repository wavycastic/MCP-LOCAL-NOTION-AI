import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { withLock } from "../lock.js"
import { audit } from "../log.js"
import { createFile, createFileSchema } from "./createFile.js"
import { editFile, editFileSchema } from "./editFile.js"
import { gitBlame, gitBlameSchema } from "./gitBlame.js"
import { gitCommit, gitCommitSchema } from "./gitCommit.js"
import { gitDiff, gitDiffSchema } from "./gitDiff.js"
import { gitLog, gitLogSchema } from "./gitLog.js"
import { gitPush } from "./gitPush.js"
import { gitStatus } from "./gitStatus.js"
import { listDir, listDirSchema } from "./listDir.js"
import { moveFile, moveFileSchema } from "./moveFile.js"
import { readFile, readFileSchema } from "./readFile.js"
import { reindex } from "./reindex.js"
import { removeFile, removeFileSchema } from "./removeFile.js"
import { ripgrep, ripgrepSchema } from "./ripgrep.js"
import { runBuild, runTests, runTestsSchema } from "./runTests.js"

type Handler = (args: any) => Promise<unknown>

type Opts = {
	/** Tool chi doc: khong lock, annotation readOnlyHint. */
	readOnly?: boolean
	/** Tool xoa/ghi de: annotation destructiveHint. */
	destructive?: boolean
}

function reg(
	s: McpServer,
	name: string,
	desc: string,
	schema: any,
	fn: Handler,
	opts: Opts = {},
) {
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
				openWorldHint: false,
			},
		},
		async (args: any) => {
			const exec = async () => fn(args)
			try {
				// Tool co side effect duoc serialize de tranh race.
				const out = readOnly ? await exec() : await withLock(name, exec)
				audit(name, args, true)
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(out, null, 2) },
					],
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
	// —— Doc ——
	reg(s, "read_file", "Doc file trong repo, co phan trang theo dong. Dung cho .axaml, .csproj, CI yaml — nhung file GitNexus khong dua vao graph.", readFileSchema, readFile, { readOnly: true })
	reg(s, "list_dir", "Liet ke file/thu muc trong repo. Bo qua .git, node_modules, bin, obj, dist.", listDirSchema, listDir, { readOnly: true })
	reg(s, "ripgrep", "Tim regex trong repo bang ripgrep. Dung khi can khop chuoi/pattern chinh xac (log string, [Obsolete], usage cu the). Cau hoi kien truc thi dung GitNexus query/impact.", ripgrepSchema, ripgrep, { readOnly: true })

	// —— Sua file ——
	reg(s, "edit_file", "Sua file da ton tai bang string-replace. old_str phai khop chinh xac va duy nhat. Chi hoat dong tren branch agent/*.", editFileSchema, editFile)
	reg(s, "create_file", "Tao file MOI voi noi dung day du. Bao loi neu file da ton tai (sua file cu thi dung edit_file). Dung khi tach class ra file rieng. Chi tren branch agent/*.", createFileSchema, createFile)
	reg(s, "move_file", "Doi ten / di chuyen file bang git mv, giu history va blame. Chi tren branch agent/*.", moveFileSchema, moveFile)
	reg(s, "remove_file", "Xoa file da track bang git rm. Chi tren branch agent/*. Chi dung khi da chac khong con ai reference (kiem tra bang GitNexus impact truoc).", removeFileSchema, removeFile, { destructive: true })

	// —— Verify ——
	reg(s, "run_build", "Chay dotnet build voi -warnaserror. Khong nhan tham so.", {}, runBuild)
	reg(s, "run_tests", "Chay dotnet test. Tuy chon filter.", runTestsSchema, runTests)

	// —— Git ——
	reg(s, "git_status", "git status --porcelain + branch hien tai. Khong nhan tham so.", {}, gitStatus, { readOnly: true })
	reg(s, "git_diff", "Xem diff working tree hoac staged, tuy chon gioi han theo path hoac chi --stat.", gitDiffSchema, gitDiff, { readOnly: true })
	reg(s, "git_log", "Lich su commit gan day, tuy chon gioi han theo path va kem --stat.", gitLogSchema, gitLog, { readOnly: true })
	reg(s, "git_blame", "git blame 1 file, tuy chon gioi han theo khoang dong. Dung de biet ai/commit nao doi dong code.", gitBlameSchema, gitBlame, { readOnly: true })
	reg(s, "git_commit", "git add -A roi commit. Chi hoat dong tren branch agent/*.", gitCommitSchema, gitCommit)
	reg(s, "git_push", "Push branch agent/* len remote (--set-upstream, khong bao gio --force). Yeu cau working tree sach va ALLOW_PUSH=true.", {}, gitPush)

	// —— Graph ——
	reg(s, "reindex", "Chay lai gitnexus analyze. PHAI goi sau moi loat edit_file/create_file/move_file, truoc khi query lai GitNexus graph.", {}, reindex)
}

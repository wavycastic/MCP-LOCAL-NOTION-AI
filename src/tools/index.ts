import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { withLock } from "../lock.js"
import { audit } from "../log.js"
import { resolveRepo } from "../repos.js"
import { createFile, createFileSchema } from "./createFile.js"
import { editFile, editFileSchema } from "./editFile.js"
import { gitBlame, gitBlameSchema } from "./gitBlame.js"
import { gitCommit, gitCommitSchema } from "./gitCommit.js"
import { gitDiff, gitDiffSchema } from "./gitDiff.js"
import { gitLog, gitLogSchema } from "./gitLog.js"
import { gitPush, gitPushSchema } from "./gitPush.js"
import { gitStatus, gitStatusSchema } from "./gitStatus.js"
import { listDir, listDirSchema } from "./listDir.js"
import { listRepos } from "./listRepos.js"
import { moveFile, moveFileSchema } from "./moveFile.js"
import { readFile, readFileSchema } from "./readFile.js"
import { reindex, reindexSchema } from "./reindex.js"
import { removeFile, removeFileSchema } from "./removeFile.js"
import { ripgrep, ripgrepSchema } from "./ripgrep.js"
import { runBuild, runBuildSchema, runTests, runTestsSchema } from "./runTests.js"

type Handler = (args: any) => Promise<unknown>

type Opts = {
	/** Tool chi doc: khong lock, annotation readOnlyHint. */
	readOnly?: boolean
	/** Tool xoa du lieu: annotation destructiveHint. */
	destructive?: boolean
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
			const exec = async () => fn(args ?? {})
			try {
				// Tool co side effect duoc serialize theo tung repo de tranh race.
				const out = readOnly ? await exec() : await withLock(lockKey(args), name, exec)
				audit(name, args, true)
				return {
					content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
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
	reg(s, "read_file", "Doc file trong mot repo, phan trang theo dong. Dung cho moi file khong nam trong code graph (markup, project file, CI yaml, config).", readFileSchema, readFile, { readOnly: true })
	reg(s, "list_dir", "Liet ke file/thu muc trong repo. Bo qua .git, node_modules, bin, obj, dist, target, .venv.", listDirSchema, listDir, { readOnly: true })
	reg(s, "ripgrep", "Tim regex trong mot repo bang ripgrep. Dung khi can khop chuoi/pattern chinh xac. Cau hoi kien truc thi dung code graph (GitNexus) neu repo do co index.", ripgrepSchema, ripgrep, { readOnly: true })

	// —— Sua file (chi repo co write: true) ——
	reg(s, "edit_file", "Sua file da ton tai bang string-replace. old_str phai khop chinh xac va duy nhat. Chi tren repo co quyen ghi va dang o branch dung prefix.", editFileSchema, editFile)
	reg(s, "create_file", "Tao file MOI voi noi dung day du. Bao loi neu file da ton tai (sua file cu thi dung edit_file). Dung khi tach class/module ra file rieng.", createFileSchema, createFile)
	reg(s, "move_file", "Doi ten / di chuyen file bang git mv, giu history va blame. Khong di chuyen cheo repo.", moveFileSchema, moveFile)
	reg(s, "remove_file", "Xoa file da track bang git rm. Chi dung khi da chac khong con reference nao (kiem tra bang code graph hoac ripgrep truoc).", removeFileSchema, removeFile, { destructive: true })

	// —— Verify ——
	reg(s, "run_build", "Chay lenh build cua repo (khai bao trong repos.json, hoac doan tu toolchain). Khong nhan argv tuy y.", runBuildSchema, runBuild)
	reg(s, "run_tests", "Chay lenh test cua repo. Tuy chon filter (chi toolchain dotnet).", runTestsSchema, runTests)

	// —— Git ——
	reg(s, "git_status", "git status --porcelain + branch hien tai + repo nay co dang ghi duoc khong.", gitStatusSchema, gitStatus, { readOnly: true })
	reg(s, "git_diff", "Xem diff working tree hoac staged, tuy chon gioi han theo path hoac chi --stat.", gitDiffSchema, gitDiff, { readOnly: true })
	reg(s, "git_log", "Lich su commit gan day, tuy chon gioi han theo path va kem --stat.", gitLogSchema, gitLog, { readOnly: true })
	reg(s, "git_blame", "git blame 1 file, tuy chon gioi han theo khoang dong. Dung de biet ai/commit nao doi dong code.", gitBlameSchema, gitBlame, { readOnly: true })
	reg(s, "git_commit", "git add -A roi commit trong mot repo. Chi tren repo co quyen ghi va branch dung prefix.", gitCommitSchema, gitCommit)
	reg(s, "git_push", "Push branch hien tai len remote (--set-upstream, khong bao gio --force). Yeu cau working tree sach va ALLOW_PUSH=true.", gitPushSchema, gitPush)

	// —— Code graph ——
	reg(s, "reindex", "Chay lai lenh index code graph cua repo (mac dinh: npx gitnexus analyze). PHAI goi sau moi loat sua file, truoc khi query lai graph.", reindexSchema, reindex)
}

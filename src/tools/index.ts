import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { audit } from "../log.js"
import { editFile, editFileSchema } from "./editFile.js"
import { gitBlame, gitBlameSchema } from "./gitBlame.js"
import { gitCommit, gitCommitSchema } from "./gitCommit.js"
import { gitDiff, gitDiffSchema } from "./gitDiff.js"
import { gitStatus } from "./gitStatus.js"
import { listDir, listDirSchema } from "./listDir.js"
import { readFile, readFileSchema } from "./readFile.js"
import { reindex } from "./reindex.js"
import { ripgrep, ripgrepSchema } from "./ripgrep.js"
import { runBuild, runTests, runTestsSchema } from "./runTests.js"

type Handler = (args: any) => Promise<unknown>

function wrap(name: string, fn: Handler): Handler {
	return async (args) => {
		try {
			const out = await fn(args)
			audit(name, args, true)
			return out
		} catch (e) {
			audit(name, args, false, String(e))
			throw e
		}
	}
}

function reg(s: McpServer, name: string, desc: string, schema: any, fn: Handler) {
	s.registerTool(
		name,
		{ description: desc, inputSchema: schema },
		async (args: any) => ({
			content: [
				{ type: "text" as const, text: JSON.stringify(await wrap(name, fn)(args), null, 2) },
			],
		}),
	)
}

export function registerAll(s: McpServer) {
	reg(s, "read_file", "Doc file trong repo, co phan trang theo dong. Dung cho .axaml, .csproj, CI yaml — nhung file GitNexus khong dua vao graph.", readFileSchema, readFile)
	reg(s, "list_dir", "Liet ke file/thu muc trong repo. Bo qua .git, node_modules, bin, obj, dist.", listDirSchema, listDir)
	reg(s, "ripgrep", "Tim regex trong repo bang ripgrep. Dung khi can khop chuoi/pattern chinh xac (log string, [Obsolete], usage cu the). Cau hoi kien truc thi dung GitNexus query/impact.", ripgrepSchema, ripgrep)
	reg(s, "edit_file", "Sua file bang string-replace. old_str phai khop chinh xac va duy nhat. Chi hoat dong tren branch agent/*.", editFileSchema, editFile)
	reg(s, "run_build", "Chay dotnet build voi -warnaserror. Khong nhan tham so.", {}, runBuild)
	reg(s, "run_tests", "Chay dotnet test. Tuy chon filter.", runTestsSchema, runTests)
	reg(s, "git_status", "git status --porcelain + branch hien tai. Khong nhan tham so.", {}, gitStatus)
	reg(s, "git_diff", "Xem diff working tree hoac staged, tuy chon gioi han theo path hoac chi --stat.", gitDiffSchema, gitDiff)
	reg(s, "git_blame", "git blame 1 file, tuy chon gioi han theo khoang dong. Dung de biet ai/commit nao doi dong code.", gitBlameSchema, gitBlame)
	reg(s, "git_commit", "git add -A roi commit. Chi hoat dong tren branch agent/*.", gitCommitSchema, gitCommit)
	reg(s, "reindex", "Chay lai gitnexus analyze. PHAI goi sau moi loat edit_file, truoc khi query lai GitNexus graph.", {}, reindex)
}

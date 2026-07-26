import { realpathSync } from "node:fs"

function req(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`missing env ${name}`)
	return v
}

function bool(name: string, dflt: boolean): boolean {
	const v = process.env[name]
	if (v === undefined || v === "") return dflt
	return /^(1|true|yes|on)$/i.test(v)
}

export const REPO_ROOT = realpathSync(req("REPO_ROOT"))
export const MCP_TOKEN = req("MCP_TOKEN")
export const PORT = Number(process.env.PORT ?? 8765)
export const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "agent/"
export const BUILD_CMD = (process.env.BUILD_CMD ?? "dotnet build").split(" ")
export const TEST_CMD = (process.env.TEST_CMD ?? "dotnet test").split(" ")
export const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS ?? 900_000)
export const MAX_OUTPUT = 200_000

// Git remote cho git_push. Push bi tat mac dinh — bat khi luong commit da on.
export const GIT_REMOTE = process.env.GIT_REMOTE ?? "origin"
export const ALLOW_PUSH = bool("ALLOW_PUSH", false)

// Tran an toan cho create_file (bytes).
export const MAX_WRITE_BYTES = Number(process.env.MAX_WRITE_BYTES ?? 1_000_000)

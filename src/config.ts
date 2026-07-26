import { realpathSync } from "node:fs"

function req(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`missing env ${name}`)
	return v
}

export const REPO_ROOT = realpathSync(req("REPO_ROOT"))
export const MCP_TOKEN = req("MCP_TOKEN")
export const PORT = Number(process.env.PORT ?? 8765)
export const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "agent/"
export const BUILD_CMD = (process.env.BUILD_CMD ?? "dotnet build").split(" ")
export const TEST_CMD = (process.env.TEST_CMD ?? "dotnet test").split(" ")
export const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS ?? 900_000)
export const MAX_OUTPUT = 200_000

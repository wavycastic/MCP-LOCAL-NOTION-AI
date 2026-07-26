import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express from "express"
import { timingSafeEqual } from "node:crypto"
import {
	ALLOW_PUSH,
	MCP_TOKEN,
	PORT,
	REPOS_CONFIG,
	WORKSPACE_ROOT,
} from "./config.js"
import { lockState } from "./lock.js"
import { allRepos } from "./repos.js"
import { registerAll } from "./tools/index.js"

function tokenOk(header?: string): boolean {
	const got = header?.replace(/^Bearer\s+/i, "") ?? ""
	const a = Buffer.from(got)
	const b = Buffer.from(MCP_TOKEN)
	return a.length === b.length && timingSafeEqual(a, b)
}

const app = express()
app.use(express.json({ limit: "8mb" }))

// Health check dat TRUOC auth: tunnel/uptime probe khong can token.
// Khong tiet lo ten repo hay duong dan.
app.get("/health", (_req, res) => {
	let repoCount: number | null = null
	try {
		repoCount = allRepos().length
	} catch {}
	res.json({
		ok: true,
		uptime_s: Math.round(process.uptime()),
		repos: repoCount,
		locks: lockState(),
	})
})

app.use((req, res, next) => {
	if (!tokenOk(req.header("authorization"))) {
		console.warn(`401 ${req.method} ${req.path}`)
		res.status(401).json({ error: "unauthorized" })
		return
	}
	next()
})

app.all("/mcp", async (req, res) => {
	const server = new McpServer({ name: "local-repo-mcp", version: "0.3.0" })
	registerAll(server)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined, // stateless
	})
	res.on("close", () => {
		transport.close()
		server.close()
	})
	try {
		await server.connect(transport)
		await transport.handleRequest(req, res, req.body)
	} catch (e) {
		console.error("mcp request failed", e)
		if (!res.headersSent) res.status(500).json({ error: "internal error" })
	}
})

const httpServer = app.listen(PORT, "127.0.0.1", () => {
	console.log(`local-repo-mcp on http://127.0.0.1:${PORT}/mcp`)
	console.log(`repos config:   ${REPOS_CONFIG}`)
	console.log(`workspace root: ${WORKSPACE_ROOT ?? "(khong dat)"}`)
	console.log(`push enabled:   ${ALLOW_PUSH}`)
	try {
		const repos = allRepos()
		if (repos.length === 0) {
			console.warn("CANH BAO: chua co repo nao. Them vao repos.json hoac dat WORKSPACE_ROOT")
		}
		for (const r of repos) {
			console.log(
				`  ${r.write ? "rw" : "ro"}  ${r.name.padEnd(24)} ${r.toolchain.padEnd(8)} ${r.root}`,
			)
		}
	} catch (e) {
		console.error("khong load duoc danh sach repo:", e)
	}
})

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		console.log(`${sig} — shutting down`)
		httpServer.close(() => process.exit(0))
	})
}

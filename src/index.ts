import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express from "express"
import { timingSafeEqual } from "node:crypto"
import { ALLOW_PUSH, BRANCH_PREFIX, MCP_TOKEN, PORT, REPO_ROOT } from "./config.js"
import { lockState } from "./lock.js"
import { registerAll } from "./tools/index.js"

function tokenOk(header?: string): boolean {
	const got = header?.replace(/^Bearer\s+/i, "") ?? ""
	const a = Buffer.from(got)
	const b = Buffer.from(MCP_TOKEN)
	return a.length === b.length && timingSafeEqual(a, b)
}

const app = express()
app.use(express.json({ limit: "8mb" }))

// Health check dat TRUOC auth: tunnel/uptime probe khong can token,
// va khong tiet lo gi ngoai trang thai process.
app.get("/health", (_req, res) => {
	res.json({ ok: true, uptime_s: Math.round(process.uptime()), lock: lockState() })
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
	const server = new McpServer({ name: "cvaut-local", version: "0.2.0" })
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
	console.log(`cvaut-local-mcp on http://127.0.0.1:${PORT}/mcp`)
	console.log(`repo root:     ${REPO_ROOT}`)
	console.log(`write branch:  ${BRANCH_PREFIX}*`)
	console.log(`push enabled:  ${ALLOW_PUSH}`)
})

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		console.log(`${sig} — shutting down`)
		httpServer.close(() => process.exit(0))
	})
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express from "express"
import { timingSafeEqual } from "node:crypto"
import { MCP_TOKEN, PORT, REPO_ROOT } from "./config.js"
import { registerAll } from "./tools/index.js"

function tokenOk(header?: string): boolean {
	const got = header?.replace(/^Bearer\s+/i, "") ?? ""
	const a = Buffer.from(got)
	const b = Buffer.from(MCP_TOKEN)
	return a.length === b.length && timingSafeEqual(a, b)
}

const app = express()
app.use(express.json({ limit: "8mb" }))

app.use((req, res, next) => {
	if (!tokenOk(req.header("authorization"))) {
		res.status(401).json({ error: "unauthorized" })
		return
	}
	next()
})

app.all("/mcp", async (req, res) => {
	const server = new McpServer({ name: "cvaut-local", version: "0.1.0" })
	registerAll(server)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined, // stateless
	})
	res.on("close", () => {
		transport.close()
		server.close()
	})
	await server.connect(transport)
	await transport.handleRequest(req, res, req.body)
})

app.listen(PORT, "127.0.0.1", () => {
	console.log(`cvaut-local-mcp on http://127.0.0.1:${PORT}/mcp`)
	console.log(`repo root: ${REPO_ROOT}`)
})

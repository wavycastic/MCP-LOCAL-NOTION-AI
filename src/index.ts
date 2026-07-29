import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express from "express"
import { timingSafeEqual } from "node:crypto"
import {
	ALLOW_PUSH,
	HOST,
	MCP_TOKEN,
	PORT,
	REPOS_CONFIG,
	WORKSPACE_ROOT,
} from "./config.js"
import { killRunningJobs } from "./jobs.js"
import { killAllPtySessions } from "./ptySessions.js"
import { lockState } from "./lock.js"
import { allRepos } from "./repos.js"
import { registerAll } from "./tools/index.js"
import { replayPendingQueues } from "./flowlens.js"

function tokenOk(header?: string): boolean {
	const got = header?.replace(/^Bearer\s+/i, "") ?? ""
	const a = Buffer.from(got)
	const b = Buffer.from(MCP_TOKEN)
	return a.length === b.length && timingSafeEqual(a, b)
}

const app = express()
app.use(express.json({ limit: "8mb" }))

/**
 * Health check dat TRUOC auth: tunnel/uptime probe khong can token. Vi vay bat ky
 * ai biet URL tunnel deu doc duoc — chi tra so dem, KHONG tra ten repo, duong dan,
 * hay ten tool dang chay. (Truoc day tra thang lockState() nen lo duong dan tuyet
 * doi kieu E:/Projects/... ra ngoai.)
 */
app.get("/health", (_req, res) => {
	let repoCount: number | null = null
	try {
		repoCount = allRepos().length
	} catch {}
	res.json({
		ok: true,
		uptime_s: Math.round(process.uptime()),
		repos: repoCount,
		busy_repos: lockState().length,
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

/** Chi tiet lock (co duong dan) chi cho nguoi da co token. */
app.get("/locks", (_req, res) => {
	res.json({ locks: lockState() })
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

const httpServer = app.listen(PORT, HOST, () => {
	console.log(`local-repo-mcp on http://${HOST}:${PORT}/mcp`)
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
		// Replay pending-index queues after restart (fire-and-forget)
		replayPendingQueues(repos).catch((e) => console.warn("[pendingQueue] startup replay error:", e))
	} catch (e) {
		console.error("khong load duoc danh sach repo:", e)
	}
})

/**
 * Tat server: phai giet cac job dang chay TRUOC khi thoat.
 *
 * Truoc day chi dong HTTP server roi exit(0). `dotnet build` hay
 * `npx gitnexus analyze` la tien trinh con, khong chet theo cha tren Windows:
 * chung chay tiep, giu khoa file trong repo (bin/obj), va khong con ai doc duoc
 * ket qua vi bang job da bay cung process. Ctrl+C hai lan van thoat ngay duoc.
 */
let shuttingDown = false

function shutdown(sig: string) {
	if (shuttingDown) {
		console.log(`${sig} lan hai — thoat ngay`)
		process.exit(130)
	}
	shuttingDown = true

	const killed = killRunningJobs()
	const killedPty = killAllPtySessions()
	console.log(`${sig} — shutting down${killed > 0 ? `, da huy ${killed} job dang chay` : ""}${killedPty > 0 ? `, da dong ${killedPty} PTY session` : ""}`)

	httpServer.close(() => process.exit(0))

	// Ket noi dang mo co the giu server song vo han; dung cho mai.
	const t = setTimeout(() => process.exit(0), 5_000)
	t.unref()
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => shutdown(sig))
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express from "express"
import compression from "compression"
import { createHash, timingSafeEqual } from "node:crypto"
import {
	ALLOW_PUSH,
	HOST,
	MCP_TOKEN,
	PORT,
	REPOS_CONFIG,
	VERSION,
	WORKSPACE_ROOT,
} from "./config.js"
import { killRunningJobs } from "./jobs.js"
import { killAllPtySessions } from "./ptySessions.js"
import { lockState } from "./lock.js"
import { allRepos } from "./repos.js"
import { registerAll } from "./tools/index.js"
import { prewarmHeads } from "./contextCache.js"

/**
 * So sanh token sau khi bam SHA-256.
 *
 * Truoc day: `a.length === b.length && timingSafeEqual(a, b)`. Toan tu && short-circuit
 * ngay o phep so sanh do dai, nen thoi gian phan hoi van lo do dai token — dung
 * timingSafeEqual ma van con kenh timing. Bam truoc cho hai ben cung 32 byte thi phep
 * so sanh moi thuc su la hang so.
 */
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest()
const TOKEN_DIGEST = sha256(MCP_TOKEN)

function tokenOk(header?: string): boolean {
	const got = header?.replace(/^Bearer\s+/i, "") ?? ""
	return timingSafeEqual(sha256(got), TOKEN_DIGEST)
}

const app = express()

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

/**
 * Body parser dat SAU auth, va chi mount vao /mcp.
 *
 * Truoc day `app.use(express.json({ limit: "8mb" }))` nam ngay dau chuoi middleware,
 * nghia la MOI request — ke ca request khong co token — deu duoc parse toi 8MB JSON
 * TRUOC khi bi tu choi 401. Ai biet URL tunnel deu bat server nay lam viec mien phi,
 * khong can biet token. Auth phai chan truoc khi ta bo mot byte cong suc nao ra.
 */
app.use("/mcp", express.json({ limit: "8mb" }))

// Nen gzip cho payload lon (get_feature_context/analyze_feature tra hang tram KB qua tunnel).
// Chi nen JSON response — khong duoc dem buffer SSE stream (text/event-stream).
app.use(
	"/mcp",
	compression({
		// level 1: payload tram KB qua tunnel can TOC DO nen hon ty le nen.
		level: 1,
		filter: (_req, res) => /json/.test(String(res.getHeader("content-type") ?? "")),
	}),
)

/** Chi tiet lock (co duong dan) chi cho nguoi da co token. */
app.get("/locks", (_req, res) => {
	res.json({ locks: lockState() })
})

app.all("/mcp", async (req, res) => {
	const server = new McpServer({ name: "local-repo-mcp", version: VERSION })
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
	} catch (e) {
		console.error("khong load duoc danh sach repo:", e)
	}
	// Lay san git HEAD cua tung repo cho tang cache context — query dau tien khoi phai
	// spawn them 1 tien trinh git. Fire-and-forget: loi thi query dau tu lay lai.
	prewarmHeads().catch(() => {})

	// Warm san symbol index (tree-sitter) cho moi repo o background: query
	// trace_flow/get_feature_context dau tien sau khoi dong se hit disk/RAM cache
	// (~50ms) thay vi tra cold build (~800ms). Tran 2 repo mot luc de khong do bo
	// CPU ngay luc boot. Dynamic import giu startup path khong keo them module.
	// Fire-and-forget nhu prewarmHeads: loi bat ky thi query dau tu build lai,
	// khong bao gio lam sap server (getSymbolIndex von khong throw).
	void (async () => {
		const { mapLimit } = await import("./files/concurrency.js")
		const { getSymbolIndex } = await import("./symbolIndex.js")
		await mapLimit(allRepos(), 2, (r) => getSymbolIndex(r.root))
	})().catch(() => {})
})

/**
 * Tat server: phai giet cac job dang chay TRUOC khi thoat.
 *
 * Truoc day chi dong HTTP server roi exit(0). `dotnet build` hay
 * `npm test` la tien trinh con, khong chet theo cha tren Windows:
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

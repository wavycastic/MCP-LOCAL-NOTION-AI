import { app, BrowserWindow, ipcMain, Menu, MenuItem, nativeImage, safeStorage, Tray } from "electron"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

type ProcState = { running: boolean; pid: number | null; startedAt: string | null }
type DashboardConfig = {
	mcpLocalUrl: string
	mcpPublicUrl: string | null
	mcpToken: string | null
}
type SavedDashboardConfig = Partial<Pick<DashboardConfig, "mcpPublicUrl" | "mcpToken">>

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const procs: Record<"mcp" | "tunnel", { child: ChildProcessWithoutNullStreams | null; startedAt: string | null }> = {
	mcp: { child: null, startedAt: null },
	tunnel: { child: null, startedAt: null },
}

function randomToken(): string {
	return randomBytes(32).toString("hex")
}

function savedConfigPath(): string {
	return join(app.getPath("userData"), "dashboard-config.json")
}

const ENC_PREFIX = "enc:v1:"

/** Ma hoa token truoc khi ghi dia (DPAPI tren Windows). Khong co thi giu plaintext nhu cu. */
function protectToken(value: string): string {
	if (value.startsWith(ENC_PREFIX)) return value
	try {
		if (safeStorage.isEncryptionAvailable()) {
			return ENC_PREFIX + safeStorage.encryptString(value).toString("base64")
		}
	} catch {}
	return value
}

/** Ban cu plaintext van doc duoc; ban ma hoa ma khong giai duoc (doi may/user) thi tra rong de sinh token moi. */
function unprotectToken(value: string): string {
	if (!value.startsWith(ENC_PREFIX)) return value
	try {
		if (safeStorage.isEncryptionAvailable()) {
			return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), "base64"))
		}
	} catch {}
	return ""
}

function readSavedConfig(): SavedDashboardConfig {
	const p = savedConfigPath()
	if (!existsSync(p)) return {}
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as SavedDashboardConfig
		if (raw.mcpToken) raw.mcpToken = unprotectToken(raw.mcpToken)
		return raw
	} catch {
		return {}
	}
}

function writeSavedConfig(cfg: SavedDashboardConfig): SavedDashboardConfig {
	const current = readSavedConfig()
	const next: SavedDashboardConfig = { ...current, ...cfg }
	mkdirSync(dirname(savedConfigPath()), { recursive: true })
	// Token la bi mat dang nhap — khong ghi plaintext xuong dia.
	const toDisk: SavedDashboardConfig = {
		...next,
		...(next.mcpToken ? { mcpToken: protectToken(next.mcpToken) } : {}),
	}
	writeFileSync(savedConfigPath(), JSON.stringify(toDisk, null, 2), "utf8")
	return next
}

function rootDir(): string {
	return app.getAppPath()
}

/**
 * Cac thu muc co the chua cau hinh THAT cua nguoi dung, theo do uu tien.
 *
 * app.getAppPath() co y KHONG nam trong day: electron-builder copy repos.json vao
 * resources/app, nen neu de appPath thang thi ban dong goi luon thang cau hinh
 * that — sua repos.json trong project khong con tac dung, va .env that
 * (WORKSPACE_ROOT, FULL_ACCESS_CWD, token) bi bo qua. appPath chi la duong lui
 * cuoi cung trong repoRoot().
 */
function configDirCandidates(): string[] {
	const out: string[] = []
	const push = (d?: string | null) => {
		if (d && typeof d === "string" && !out.includes(d)) out.push(d)
	}

	push(process.env.LOCAL_REPO_MCP_HOME)
	push(process.env.PORTABLE_EXECUTABLE_DIR)
	if (app.isPackaged) {
		// Ban portable thuong nam trong release/win-unpacked cua chinh project, nen
		// cau hinh that o mot trong cac thu muc cha. Gioi han 4 cap cho khoi leo ra
		// tan goc o dia.
		let dir = dirname(process.execPath)
		for (let i = 0; i < 4; i++) {
			push(dir)
			const parent = dirname(dir)
			if (parent === dir) break
			dir = parent
		}
	}
	push(process.cwd())
	return out
}

function repoRoot(): string {
	const candidates = configDirCandidates()
	// .env truoc repos.json: .env la thu chi nguoi dung tao, con repos.json co the
	// la ban mac dinh di kem app.
	for (const dir of candidates) {
		if (existsSync(join(dir, ".env"))) return dir
	}
	for (const dir of candidates) {
		if (existsSync(join(dir, "repos.json"))) return dir
	}

	const appDir = app.getAppPath()
	if (existsSync(join(appDir, "repos.json")) || existsSync(join(appDir, ".env"))) return appDir
	return app.isPackaged ? dirname(process.execPath) : process.cwd()
}

function readEnvValue(key: string): string | null {
	return readEnvFile()[key] ?? null
}

function readEnvFile(): Record<string, string> {
	const p = join(repoRoot(), ".env")
	if (!existsSync(p)) return {}
	const envs: Record<string, string> = {}
	for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith("#")) continue
		const idx = trimmed.indexOf("=")
		if (idx > 0) {
			const key = trimmed.slice(0, idx).trim()
			const val = trimmed.slice(idx + 1).split("#")[0].trim()
			envs[key] = val
		}
	}
	return envs
}

function dashboardConfig(env: Record<string, string> = {}): DashboardConfig {
	const saved = readSavedConfig()
	const host = env.HOST || readEnvValue("HOST") || "127.0.0.1"
	const port = env.PORT || readEnvValue("PORT") || "8765"
	const mcpToken = env.MCP_TOKEN || saved.mcpToken || readEnvValue("MCP_TOKEN") || randomToken()
	const nextCfg: SavedDashboardConfig = {
		mcpToken,
		mcpPublicUrl: saved.mcpPublicUrl || "https://mcp.wavycastic.id.vn/mcp",
	}
	// Chi ghi khi co thay doi — truoc day MOI lan goi ham nay deu ghi file, ma no
	// bi goi lap nhieu lan moi lan start service.
	if (saved.mcpToken !== nextCfg.mcpToken || saved.mcpPublicUrl !== nextCfg.mcpPublicUrl) {
		writeSavedConfig(nextCfg)
	}
	return {
		mcpLocalUrl: `http://${host}:${port}/mcp`,
		mcpPublicUrl: saved.mcpPublicUrl || "https://mcp.wavycastic.id.vn/mcp",
		mcpToken,
	}
}

function state() {
	const one = (k: "mcp" | "tunnel"): ProcState => ({
		running: !!procs[k].child,
		pid: procs[k].child?.pid ?? null,
		startedAt: procs[k].startedAt,
	})
	return { mcp: one("mcp"), tunnel: one("tunnel") }
}

function send(channel: string, payload: unknown) {
	win?.webContents.send(channel, payload)
}

function appendLog(source: "mcp" | "tunnel" | "gui", text: string) {
	send("log", { at: new Date().toISOString(), source, text })
}

function getIconPath(): string {
	const p1 = join(rootDir(), "dist", "gui", "icon.png")
	if (existsSync(p1)) return p1
	const p2 = join(rootDir(), "src", "gui", "icon.png")
	if (existsSync(p2)) return p2
	return ""
}

function createTray() {
	if (tray) return
	const iconPath = getIconPath()
	const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
	tray = new Tray(icon)
	tray.setToolTip("local-repo-mcp")

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "Open Dashboard",
			click: () => {
				if (win) {
					win.show()
					win.focus()
				}
			},
		},
		{
			label: "Start All Services",
			click: () => {
				send("command", "start-all")
			},
		},
		{
			label: "Stop All Services",
			click: () => {
				send("command", "stop-all")
			},
		},
		{ type: "separator" },
		{
			label: "Quit",
			click: () => {
				isQuitting = true
				app.quit()
			},
		},
	])

	tray.setContextMenu(contextMenu)
	tray.on("click", () => {
		if (win?.isVisible()) {
			win.hide()
		} else {
			win?.show()
			win?.focus()
		}
	})
}

function createWindow() {
	const iconPath = getIconPath()
	win = new BrowserWindow({
		width: 520,
		height: 480,
		resizable: false,
		maximizable: false,
		autoHideMenuBar: true,
		icon: iconPath || undefined,
		webPreferences: {
			preload: join(rootDir(), "dist", "gui", "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	})
	win.setMenu(null)
	win.loadFile(join(rootDir(), "dist", "gui", "renderer.html"))
	
	win.webContents.on("context-menu", (_evt, params) => {
		const menu = new Menu()
		if (params.isEditable) {
			menu.append(new MenuItem({ label: "Cut", role: "cut" }))
			menu.append(new MenuItem({ label: "Copy", role: "copy" }))
			menu.append(new MenuItem({ label: "Paste", role: "paste" }))
			menu.append(new MenuItem({ label: "Select All", role: "selectAll" }))
		} else if (params.selectionText.trim().length > 0) {
			menu.append(new MenuItem({ label: "Copy", role: "copy" }))
			menu.append(new MenuItem({ label: "Select All", role: "selectAll" }))
		} else {
			menu.append(new MenuItem({ label: "Select All", role: "selectAll" }))
		}
		if (menu.items.length > 0) {
			menu.popup({ window: win ?? undefined })
		}
	})

	// Prevent app exit on close click -> hide to tray instead
	win.on("close", (evt) => {
		if (!isQuitting) {
			evt.preventDefault()
			win?.hide()
		}
	})
	win.on("closed", () => (win = null))
}

function startMcp(env: Record<string, string>) {
	if (procs.mcp.child) return state()
	const entry = join(rootDir(), "dist", "index.js")
	if (!existsSync(entry)) throw new Error(`khong tim thay ${entry}. Chay npm run build truoc`)
	procs.mcp.startedAt = new Date().toISOString()

	const envFile = readEnvFile()
	const mergedEnv: Record<string, string> = {
		...envFile,
		...(process.env as Record<string, string>),
		...env,
	}

	if (!mergedEnv.REPOS_CONFIG) {
		const reposPath = join(repoRoot(), "repos.json")
		if (existsSync(reposPath)) mergedEnv.REPOS_CONFIG = reposPath
	}
	if (!mergedEnv.FULL_ACCESS_CWD) {
		mergedEnv.FULL_ACCESS_CWD = mergedEnv.WORKSPACE_ROOT || repoRoot()
	}
	// .env thieu MCP_TOKEN thi dung token GUI da sinh/luu — thieu dong nay la server
	// chet ngay khi boot (config.ts bat buoc MCP_TOKEN) trong khi GUI van hien token.
	if (!mergedEnv.MCP_TOKEN) {
		const generated = dashboardConfig(env).mcpToken
		if (generated) mergedEnv.MCP_TOKEN = generated
	}

	procs.mcp.child = spawn("node", [entry], {
		cwd: repoRoot(),
		env: mergedEnv,
		windowsHide: true,
	})
	wire("mcp")
	appendLog("gui", `started local-repo-mcp pid=${procs.mcp.child.pid ?? "?"}`)
	send("state", state())
	return state()
}

function startTunnel() {
	if (procs.tunnel.child) return state()
	const configYml = join(repoRoot(), "config.yml")
	const candidates = [
		join(repoRoot(), "cloudflared.exe"),
		join(rootDir(), "cloudflared.exe"),
		join(dirname(process.execPath), "cloudflared.exe"),
		join(process.cwd(), "cloudflared.exe"),
	]

	let cmd = process.platform === "win32" ? "npx.cmd" : "npx"
	let args = ["cloudflared", "tunnel", "--config", configYml, "run"]

	for (const p of candidates) {
		if (existsSync(p)) {
			cmd = p
			args = ["tunnel", "--config", configYml, "run"]
			break
		}
	}

	procs.tunnel.startedAt = new Date().toISOString()
	procs.tunnel.child = spawn(cmd, args, {
		cwd: repoRoot(),
		env: process.env as Record<string, string>,
		windowsHide: true,
	})
	wire("tunnel")
	appendLog("gui", `started cloudflared tunnel (${cmd}) pid=${procs.tunnel.child.pid ?? "?"}`)
	send("state", state())
	return state()
}

function wire(kind: "mcp" | "tunnel") {
	const child = procs[kind].child
	if (!child) return
	child.stdout.on("data", (d) => appendLog(kind, d.toString()))
	child.stderr.on("data", (d) => appendLog(kind, d.toString()))
	child.on("exit", (code, signal) => {
		appendLog("gui", `${kind} exited code=${code ?? "null"} signal=${signal ?? "null"}`)
		procs[kind].child = null
		procs[kind].startedAt = null
		send("state", state())
	})
	child.on("error", (e) => appendLog("gui", `${kind} error: ${e.message}`))
}

function stop(kind: "mcp" | "tunnel") {
	const child = procs[kind].child
	if (!child) return state()
	appendLog("gui", `stopping ${kind}`)
	if (process.platform === "win32" && child.pid) {
		try {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
		} catch {
			child.kill("SIGKILL")
		}
	} else {
		child.kill("SIGTERM")
	}
	return state()
}

ipcMain.handle("state", () => state())
ipcMain.handle("config", (_evt: unknown, env: Record<string, string>) => dashboardConfig(env))
ipcMain.handle("save-config", (_evt: unknown, cfg: SavedDashboardConfig) => writeSavedConfig(cfg))
ipcMain.handle("start-mcp", (_evt: unknown, env: Record<string, string>) => startMcp(env))
ipcMain.handle("stop-mcp", () => stop("mcp"))
ipcMain.handle("start-tunnel", () => startTunnel())
ipcMain.handle("stop-tunnel", () => stop("tunnel"))

app.whenReady().then(() => {
	Menu.setApplicationMenu(null)
	createWindow()
	createTray()
})

app.on("window-all-closed", () => {
	if (isQuitting) {
		stop("mcp")
		stop("tunnel")
		if (process.platform !== "darwin") app.quit()
	}
})

app.on("before-quit", () => {
	isQuitting = true
	stop("mcp")
	stop("tunnel")
})

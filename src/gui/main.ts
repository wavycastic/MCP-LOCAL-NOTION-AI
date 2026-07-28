import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

type ProcState = { running: boolean; pid: number | null; startedAt: string | null }
type DashboardConfig = {
	mcpLocalUrl: string
	mcpPublicUrl: string | null
	mcpToken: string | null
	gitnexusLocalUrl: string
	gitnexusPublicUrl: string | null
	gitnexusToken: string
}
type SavedDashboardConfig = Partial<Pick<DashboardConfig, "mcpPublicUrl" | "mcpToken" | "gitnexusPublicUrl" | "gitnexusToken">>

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const procs: Record<"mcp" | "gitnexus", { child: ChildProcessWithoutNullStreams | null; startedAt: string | null }> = {
	mcp: { child: null, startedAt: null },
	gitnexus: { child: null, startedAt: null },
}

function randomToken(): string {
	return randomBytes(32).toString("hex")
}

function savedConfigPath(): string {
	return join(app.getPath("userData"), "dashboard-config.json")
}

function readSavedConfig(): SavedDashboardConfig {
	const p = savedConfigPath()
	if (!existsSync(p)) return {}
	try {
		return JSON.parse(readFileSync(p, "utf8")) as SavedDashboardConfig
	} catch {
		return {}
	}
}

function writeSavedConfig(cfg: SavedDashboardConfig): SavedDashboardConfig {
	const current = readSavedConfig()
	const next: SavedDashboardConfig = { ...current, ...cfg }
	mkdirSync(dirname(savedConfigPath()), { recursive: true })
	writeFileSync(savedConfigPath(), JSON.stringify(next, null, 2), "utf8")
	return next
}

function rootDir(): string {
	return app.getAppPath()
}

function repoRoot(): string {
	const candidates = [
		process.env.PORTABLE_EXECUTABLE_DIR,
		app.isPackaged ? dirname(dirname(process.execPath)) : null,
		app.isPackaged ? dirname(process.execPath) : null,
		process.cwd(),
		app.getAppPath(),
	].filter((d): d is string => !!d && typeof d === "string")

	for (const dir of candidates) {
		if (existsSync(join(dir, "repos.json")) || existsSync(join(dir, ".env"))) {
			return dir
		}
	}
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
	const gitPort = env.GITNEXUS_PROXY_PORT || "3000"
	const mcpToken = env.MCP_TOKEN || saved.mcpToken || readEnvValue("MCP_TOKEN") || randomToken()
	const gitToken = env.GITNEXUS_TOKEN || env.AUTH_TOKEN || saved.gitnexusToken || readEnvValue("GITNEXUS_TOKEN") || readEnvValue("AUTH_TOKEN") || randomToken()
	writeSavedConfig({
		mcpToken,
		gitnexusToken: gitToken,
		mcpPublicUrl: saved.mcpPublicUrl || "https://mcp.wavycastic.id.vn/mcp",
		gitnexusPublicUrl: saved.gitnexusPublicUrl || "https://gitnexus.wavycastic.id.vn/mcp",
	})
	return {
		mcpLocalUrl: `http://${host}:${port}/mcp`,
		mcpPublicUrl: saved.mcpPublicUrl || "https://mcp.wavycastic.id.vn/mcp",
		mcpToken,
		gitnexusLocalUrl: `http://127.0.0.1:${gitPort}/mcp`,
		gitnexusPublicUrl: saved.gitnexusPublicUrl || "https://gitnexus.wavycastic.id.vn/mcp",
		gitnexusToken: gitToken,
	}
}

function state() {
	const one = (k: "mcp" | "gitnexus"): ProcState => ({
		running: !!procs[k].child,
		pid: procs[k].child?.pid ?? null,
		startedAt: procs[k].startedAt,
	})
	return { mcp: one("mcp"), gitnexus: one("gitnexus") }
}

function send(channel: string, payload: unknown) {
	win?.webContents.send(channel, payload)
}

function appendLog(source: "mcp" | "gitnexus" | "gui", text: string) {
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
		width: 460,
		height: 350,
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
		...process.env,
		...env,
		...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
	}

	if (!mergedEnv.REPOS_CONFIG) {
		const reposPath = join(repoRoot(), "repos.json")
		if (existsSync(reposPath)) mergedEnv.REPOS_CONFIG = reposPath
	}
	if (!mergedEnv.FULL_ACCESS_CWD) {
		mergedEnv.FULL_ACCESS_CWD = mergedEnv.WORKSPACE_ROOT || repoRoot()
	}

	procs.mcp.child = spawn(process.execPath, [entry], {
		cwd: repoRoot(),
		env: mergedEnv,
		windowsHide: true,
	})
	wire("mcp")
	appendLog("gui", `started local-repo-mcp pid=${procs.mcp.child.pid ?? "?"}`)
	send("state", state())
	return state()
}

function startGitnexus(env: Record<string, string>) {
	if (procs.gitnexus.child) return state()
	const entry = join(rootDir(), "scripts", "gitnexus-proxy.mjs")
	if (!existsSync(entry)) throw new Error(`khong tim thay ${entry}`)
	const token = dashboardConfig(env).gitnexusToken
	procs.gitnexus.startedAt = new Date().toISOString()

	const envFile = readEnvFile()
	const mergedEnv: Record<string, string> = {
		...envFile,
		...process.env,
		...env,
		AUTH_TOKEN: token,
		...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
	}

	procs.gitnexus.child = spawn(process.execPath, [entry, token], {
		cwd: repoRoot(),
		env: mergedEnv,
		windowsHide: true,
	})
	wire("gitnexus")
	appendLog("gui", `started gitnexus proxy pid=${procs.gitnexus.child.pid ?? "?"}`)
	send("state", state())
	return state()
}

function wire(kind: "mcp" | "gitnexus") {
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

function stop(kind: "mcp" | "gitnexus") {
	const child = procs[kind].child
	if (!child) return state()
	appendLog("gui", `stopping ${kind}`)
	child.kill("SIGTERM")
	return state()
}

ipcMain.handle("state", () => state())
ipcMain.handle("config", (_evt: unknown, env: Record<string, string>) => dashboardConfig(env))
ipcMain.handle("save-config", (_evt: unknown, cfg: SavedDashboardConfig) => writeSavedConfig(cfg))
ipcMain.handle("start-mcp", (_evt: unknown, env: Record<string, string>) => startMcp(env))
ipcMain.handle("stop-mcp", () => stop("mcp"))
ipcMain.handle("start-gitnexus", (_evt: unknown, env: Record<string, string>) => startGitnexus(env))
ipcMain.handle("stop-gitnexus", () => stop("gitnexus"))

app.whenReady().then(() => {
	Menu.setApplicationMenu(null)
	createWindow()
	createTray()
})

app.on("window-all-closed", () => {
	if (isQuitting) {
		stop("mcp")
		stop("gitnexus")
		if (process.platform !== "darwin") app.quit()
	}
})

app.on("before-quit", () => {
	isQuitting = true
	stop("mcp")
	stop("gitnexus")
})

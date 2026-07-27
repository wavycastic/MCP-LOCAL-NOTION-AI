import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

type ProcState = { running: boolean; pid: number | null; startedAt: string | null }
type DashboardConfig = {
	mcpLocalUrl: string
	mcpPublicUrl: string | null
	mcpToken: string | null
	gitnexusLocalUrl: string
	gitnexusPublicUrl: string | null
	gitnexusToken: string
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const procs: Record<"mcp" | "gitnexus", { child: ChildProcessWithoutNullStreams | null; startedAt: string | null }> = {
	mcp: { child: null, startedAt: null },
	gitnexus: { child: null, startedAt: null },
}

function rootDir(): string {
	return app.isPackaged ? ((process as NodeJS.Process & { resourcesPath: string }).resourcesPath as string) : process.cwd()
}

function repoRoot(): string {
	return process.cwd()
}

function readEnvValue(key: string): string | null {
	const p = join(repoRoot(), ".env")
	if (!existsSync(p)) return null
	for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
		const m = line.match(new RegExp(`^${key}=([^#]*)`))
		if (m) return m[1].trim()
	}
	return null
}

function dashboardConfig(env: Record<string, string> = {}): DashboardConfig {
	const host = env.HOST || readEnvValue("HOST") || "127.0.0.1"
	const port = env.PORT || readEnvValue("PORT") || "8765"
	const gitPort = env.GITNEXUS_PROXY_PORT || "3000"
	const gitToken = env.GITNEXUS_TOKEN || env.AUTH_TOKEN || readEnvValue("GITNEXUS_TOKEN") || readEnvValue("AUTH_TOKEN") || ""
	return {
		mcpLocalUrl: `http://${host}:${port}/mcp`,
		mcpPublicUrl: null,
		mcpToken: env.MCP_TOKEN || readEnvValue("MCP_TOKEN"),
		gitnexusLocalUrl: `http://127.0.0.1:${gitPort}/mcp`,
		gitnexusPublicUrl: null,
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
	procs.mcp.child = spawn(process.execPath, [entry], {
		cwd: rootDir(),
		env: { ...process.env, ...env, ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
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
	procs.gitnexus.child = spawn(process.execPath, [entry, token], {
		cwd: repoRoot(),
		env: { ...process.env, ...env, AUTH_TOKEN: token, ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
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

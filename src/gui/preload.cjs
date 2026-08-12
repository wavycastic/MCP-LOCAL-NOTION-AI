const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("localRepoMcp", {
	state: () => ipcRenderer.invoke("state"),
	config: (env) => ipcRenderer.invoke("config", env),
	saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
	startMcp: (env) => ipcRenderer.invoke("start-mcp", env),
	stopMcp: () => ipcRenderer.invoke("stop-mcp"),
	startTunnel: () => ipcRenderer.invoke("start-tunnel"),
	stopTunnel: () => ipcRenderer.invoke("stop-tunnel"),
	onState: (cb) => ipcRenderer.on("state", (_e, v) => cb(v)),
	onLog: (cb) => ipcRenderer.on("log", (_e, v) => cb(v)),
	onCommand: (cb) => ipcRenderer.on("command", (_e, cmd) => cb(cmd)),
})

const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("localRepoMcp", {
	state: () => ipcRenderer.invoke("state"),
	config: (env) => ipcRenderer.invoke("config", env),
	saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
	startMcp: (env) => ipcRenderer.invoke("start-mcp", env),
	stopMcp: () => ipcRenderer.invoke("stop-mcp"),
	startGitnexus: (env) => ipcRenderer.invoke("start-gitnexus", env),
	stopGitnexus: () => ipcRenderer.invoke("stop-gitnexus"),
	onState: (cb) => ipcRenderer.on("state", (_e, v) => cb(v)),
	onLog: (cb) => ipcRenderer.on("log", (_e, v) => cb(v)),
	onCommand: (cb) => ipcRenderer.on("command", (_e, cmd) => cb(cmd)),
})

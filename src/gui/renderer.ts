type State = {
	mcp: { running: boolean; pid: number | null; startedAt: string | null }
	gitnexus: { running: boolean; pid: number | null; startedAt: string | null }
}

type Config = {
	mcpLocalUrl: string
	mcpPublicUrl: string | null
	mcpToken: string | null
	gitnexusLocalUrl: string
	gitnexusPublicUrl: string | null
	gitnexusToken: string
}

type Api = {
	state: () => Promise<State>
	config: (env: Record<string, string>) => Promise<Config>
	startMcp: (env: Record<string, string>) => Promise<State>
	stopMcp: () => Promise<State>
	startGitnexus: (env: Record<string, string>) => Promise<State>
	stopGitnexus: () => Promise<State>
	onState: (cb: (state: State) => void) => void
	onLog: (cb: (line: { at: string; source: string; text: string }) => void) => void
	onCommand?: (cb: (cmd: string) => void) => void
}

declare global {
	interface Window {
		localRepoMcp: Api
	}
}

const ids = ["MCP_TOKEN", "PORT", "HOST", "ALLOW_TERMINAL", "GITNEXUS_TOKEN", "GITNEXUS_PROXY_PORT"] as const
const logEl = document.getElementById("log") as HTMLPreElement
const statusEl = document.getElementById("status") as HTMLSpanElement
let lastState: State = { mcp: { running: false, pid: null, startedAt: null }, gitnexus: { running: false, pid: null, startedAt: null } }
const els = {
	mcpLocal: document.getElementById("mcpLocal") as HTMLInputElement,
	mcpPublic: document.getElementById("mcpPublic") as HTMLInputElement,
	gitLocal: document.getElementById("gitLocal") as HTMLInputElement,
	gitPublic: document.getElementById("gitPublic") as HTMLInputElement,
	mcpToken: document.getElementById("mcpToken") as HTMLInputElement,
	gitToken: document.getElementById("gitToken") as HTMLInputElement,
	mode: document.getElementById("mode") as HTMLSpanElement,
	serviceState: document.getElementById("serviceState") as HTMLSpanElement,
	mcpToggle: document.getElementById("toggle-mcp") as HTMLButtonElement,
	gitToggle: document.getElementById("toggle-git") as HTMLButtonElement,
}

function env(): Record<string, string> {
	const out: Record<string, string> = {}
	for (const id of ids) {
		const input = document.getElementById(id) as HTMLInputElement | null
		const v = input?.value.trim() ?? ""
		if (v) out[id] = v
	}
	return out
}

function copy(text: string) {
	void navigator.clipboard.writeText(text)
}

function setState(s: State) {
	lastState = s
	const running = s.mcp.running || s.gitnexus.running
	if (statusEl) {
		statusEl.textContent = running ? `running mcp=${s.mcp.pid ?? "-"} gitnexus=${s.gitnexus.pid ?? "-"}` : "stopped"
		statusEl.classList.toggle("running", running)
	}
	if (els.serviceState) {
		els.serviceState.textContent = `MCP ${s.mcp.running ? "running" : "stopped"} | GitNexus ${s.gitnexus.running ? "running" : "stopped"}`
	}
	if (els.mcpToggle) {
		els.mcpToggle.textContent = s.mcp.running ? "Stop MCP" : "Start MCP"
		els.mcpToggle.classList.toggle("danger", s.mcp.running)
		els.mcpToggle.classList.toggle("ok", !s.mcp.running)
	}
	if (els.gitToggle) {
		els.gitToggle.textContent = s.gitnexus.running ? "Stop GitNexus" : "Start GitNexus"
		els.gitToggle.classList.toggle("danger", s.gitnexus.running)
		els.gitToggle.classList.toggle("ok", !s.gitnexus.running)
	}
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function appendLog(line: { at: string; source: string; text: string } | string) {
	if (typeof line === "string") {
		const div = document.createElement("div")
		div.className = "log-line"
		div.textContent = line
		logEl.appendChild(div)
	} else {
		const div = document.createElement("div")
		div.className = "log-line"
		let srcClass = "log-src-sys"
		if (line.source.toLowerCase().includes("mcp")) srcClass = "log-src-mcp"
		else if (line.source.toLowerCase().includes("gitnexus")) srcClass = "log-src-gitnexus"
		
		div.innerHTML = `<span class="log-time">[${escapeHtml(line.at)}]</span> <span class="${srcClass}">${escapeHtml(line.source)}:</span> ${escapeHtml(line.text)}`
		logEl.appendChild(div)
	}
	logEl.scrollTop = logEl.scrollHeight
}

async function refreshConfig() {
	const c = await window.localRepoMcp.config(env())
	if (els.mcpLocal) els.mcpLocal.value = c.mcpLocalUrl
	els.mcpPublic.value = localStorage.getItem("mcpPublicUrl") || c.mcpPublicUrl || ""
	if (els.gitLocal) els.gitLocal.value = c.gitnexusLocalUrl
	els.gitPublic.value = localStorage.getItem("gitnexusPublicUrl") || c.gitnexusPublicUrl || ""
	const mcpToken = localStorage.getItem("mcpToken") || c.mcpToken || ""
	const gitToken = localStorage.getItem("gitnexusToken") || c.gitnexusToken
	els.mcpToken.value = mcpToken
	els.gitToken.value = gitToken
	;(document.getElementById("MCP_TOKEN") as HTMLInputElement).value = mcpToken
	;(document.getElementById("GITNEXUS_TOKEN") as HTMLInputElement).value = gitToken
	if (els.mode) els.mode.textContent = "Local only"
}

function randomToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function saveCustomValues() {
	localStorage.setItem("mcpPublicUrl", els.mcpPublic.value.trim())
	localStorage.setItem("gitnexusPublicUrl", els.gitPublic.value.trim())
	localStorage.setItem("mcpToken", els.mcpToken.value.trim())
	localStorage.setItem("gitnexusToken", els.gitToken.value.trim())
	;(document.getElementById("MCP_TOKEN") as HTMLInputElement).value = els.mcpToken.value.trim()
	;(document.getElementById("GITNEXUS_TOKEN") as HTMLInputElement).value = els.gitToken.value.trim()
}

// 2-Tab Navigation Switching
const tabConfigBtn = document.getElementById("tab-btn-config")
const tabLogBtn = document.getElementById("tab-btn-log")
const viewConfig = document.getElementById("view-config")
const viewLog = document.getElementById("view-log")

tabConfigBtn?.addEventListener("click", () => {
	tabConfigBtn.classList.add("active")
	tabLogBtn?.classList.remove("active")
	viewConfig?.classList.remove("hidden")
	viewLog?.classList.add("hidden")
})

tabLogBtn?.addEventListener("click", () => {
	tabLogBtn.classList.add("active")
	tabConfigBtn?.classList.remove("active")
	viewLog?.classList.remove("hidden")
	viewConfig?.classList.add("hidden")
})

// Auto-save on typing/input change
els.mcpPublic?.addEventListener("input", saveCustomValues)
els.gitPublic?.addEventListener("input", saveCustomValues)
els.mcpToken?.addEventListener("input", saveCustomValues)
els.gitToken?.addEventListener("input", saveCustomValues)

document.getElementById("start-all")?.addEventListener("click", async () => {
	saveCustomValues()
	if (!lastState.mcp.running) await window.localRepoMcp.startMcp(env())
	if (!lastState.gitnexus.running) await window.localRepoMcp.startGitnexus(env())
})

document.getElementById("stop-all")?.addEventListener("click", async () => {
	if (lastState.mcp.running) await window.localRepoMcp.stopMcp()
	if (lastState.gitnexus.running) await window.localRepoMcp.stopGitnexus()
})

document.getElementById("toggle-mcp")?.addEventListener("click", async () => {
	saveCustomValues()
	if (lastState.mcp.running) await window.localRepoMcp.stopMcp()
	else await window.localRepoMcp.startMcp(env())
})
document.getElementById("toggle-git")?.addEventListener("click", async () => {
	saveCustomValues()
	if (lastState.gitnexus.running) await window.localRepoMcp.stopGitnexus()
	else await window.localRepoMcp.startGitnexus(env())
})
document.getElementById("copy-mcp")?.addEventListener("click", () => copy(els.mcpLocal.value))
document.getElementById("copy-mcp-public")?.addEventListener("click", () => copy(els.mcpPublic.value))
document.getElementById("copy-git")?.addEventListener("click", () => copy(els.gitLocal.value))
document.getElementById("copy-git-public")?.addEventListener("click", () => copy(els.gitPublic.value))
document.getElementById("copy-mcp-token")?.addEventListener("click", () => copy(els.mcpToken.value))
document.getElementById("copy-git-token")?.addEventListener("click", () => copy(els.gitToken.value))
document.getElementById("show-mcp-token")?.addEventListener("click", () => {
	els.mcpToken.type = els.mcpToken.type === "password" ? "text" : "password"
})
document.getElementById("show-git-token")?.addEventListener("click", () => {
	els.gitToken.type = els.gitToken.type === "password" ? "text" : "password"
})
document.getElementById("save-custom")?.addEventListener("click", saveCustomValues)
document.getElementById("gen-mcp-token")?.addEventListener("click", () => {
	els.mcpToken.value = randomToken()
	saveCustomValues()
})
document.getElementById("gen-git-token")?.addEventListener("click", () => {
	els.gitToken.value = randomToken()
	saveCustomValues()
})
document.getElementById("clear")?.addEventListener("click", () => (logEl.innerHTML = ""))

window.localRepoMcp.onState(setState)
window.localRepoMcp.onLog((l) => appendLog(l))
window.localRepoMcp.onCommand?.((cmd) => {
	if (cmd === "start-all") document.getElementById("start-all")?.click()
	if (cmd === "stop-all") document.getElementById("stop-all")?.click()
})
window.localRepoMcp.state().then(setState)
refreshConfig().catch((e) => appendLog(`config error: ${e instanceof Error ? e.message : String(e)}`))

export {}

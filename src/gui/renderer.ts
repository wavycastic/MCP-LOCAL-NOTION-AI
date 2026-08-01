type State = {
	mcp: { running: boolean; pid: number | null; startedAt: string | null }
	gitnexus: { running: boolean; pid: number | null; startedAt: string | null }
	tunnel: { running: boolean; pid: number | null; startedAt: string | null }
}

type Config = {
	mcpLocalUrl: string
	mcpPublicUrl: string | null
	mcpToken: string | null
	gitnexusLocalUrl?: string
	gitnexusPublicUrl?: string | null
	gitnexusToken?: string
	allowFlowlens?: boolean
	allowGitnexus?: boolean
}

type Api = {
	state: () => Promise<State>
	config: (env: Record<string, string>) => Promise<Config>
	saveConfig?: (cfg: Partial<Pick<Config, "mcpPublicUrl" | "mcpToken">>) => Promise<unknown>
	startMcp: (env: Record<string, string>) => Promise<State>
	stopMcp: () => Promise<State>
	startGitnexus?: (env: Record<string, string>) => Promise<State>
	stopGitnexus?: () => Promise<State>
	startTunnel: () => Promise<State>
	stopTunnel: () => Promise<State>
	onState: (cb: (state: State) => void) => void
	onLog: (cb: (line: { at: string; source: string; text: string }) => void) => void
	onCommand?: (cb: (cmd: string) => void) => void
}

declare global {
	interface Window {
		localRepoMcp: Api
	}
}

const ids = ["MCP_TOKEN", "PORT", "HOST", "ALLOW_TERMINAL"] as const
const logEl = document.getElementById("log") as HTMLPreElement
const statusEl = document.getElementById("status") as HTMLSpanElement
let lastState: State = {
	mcp: { running: false, pid: null, startedAt: null },
	gitnexus: { running: false, pid: null, startedAt: null },
	tunnel: { running: false, pid: null, startedAt: null },
}
const els = {
	mcpLocal: document.getElementById("mcpLocal") as HTMLInputElement,
	mcpPublic: document.getElementById("mcpPublic") as HTMLInputElement,
	mcpToken: document.getElementById("mcpToken") as HTMLInputElement,
	allowTunnel: document.getElementById("allowTunnel") as HTMLInputElement,
	tunnelStatus: document.getElementById("tunnelStatus") as HTMLInputElement,
	toggleTunnel: document.getElementById("toggle-tunnel") as HTMLButtonElement,
	mode: document.getElementById("mode") as HTMLSpanElement,
	serviceState: document.getElementById("serviceState") as HTMLSpanElement,
	mcpToggle: document.getElementById("toggle-mcp") as HTMLButtonElement,
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
	const running = s.mcp.running || s.tunnel.running
	if (statusEl) {
		statusEl.textContent = running ? `running mcp=${s.mcp.pid ?? "-"} tunnel=${s.tunnel.pid ?? "-"}` : "stopped"
		statusEl.classList.toggle("running", running)
	}
	if (els.serviceState) {
		els.serviceState.textContent = `MCP ${s.mcp.running ? "running" : "stopped"} | Tunnel ${s.tunnel.running ? "running" : "stopped"}`
	}
	if (els.mcpToggle) {
		els.mcpToggle.textContent = s.mcp.running ? "Stop MCP" : "Start MCP"
		els.mcpToggle.classList.toggle("danger", s.mcp.running)
		els.mcpToggle.classList.toggle("ok", !s.mcp.running)
	}
	if (els.tunnelStatus) {
		els.tunnelStatus.value = s.tunnel.running ? `Running (pid=${s.tunnel.pid ?? "-"})` : "Stopped"
	}
	if (els.toggleTunnel) {
		els.toggleTunnel.textContent = s.tunnel.running ? "Stop Tunnel" : "Start Tunnel"
		els.toggleTunnel.classList.toggle("danger", s.tunnel.running)
		els.toggleTunnel.classList.toggle("ok", !s.tunnel.running)
	}
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function formatTime(isoStr: string): string {
	try {
		const d = new Date(isoStr)
		if (isNaN(d.getTime())) return isoStr
		const hh = String(d.getHours()).padStart(2, "0")
		const mm = String(d.getMinutes()).padStart(2, "0")
		const ss = String(d.getSeconds()).padStart(2, "0")
		return `${hh}:${mm}:${ss}`
	} catch {
		return isoStr
	}
}

function appendLog(line: { at: string; source: string; text: string } | string) {
	const currentFilter = (document.getElementById("log-filter") as HTMLInputElement | null)?.value.toLowerCase().trim() ?? ""

	if (typeof line === "string") {
		const div = document.createElement("div")
		div.className = "log-row"
		div.dataset.search = line.toLowerCase()
		if (currentFilter && !div.dataset.search.includes(currentFilter)) {
			div.classList.add("hidden")
		}
		div.innerHTML = `<span class="log-src log-src-sys">[sys]</span><span class="log-txt">${escapeHtml(line)}</span>`
		logEl.appendChild(div)
	} else {
		const src = line.source.toLowerCase()
		let srcClass = "log-src-sys"
		let srcTag = `[${line.source}]`
		if (src.includes("mcp")) {
			srcClass = "log-src-mcp"
			srcTag = "[mcp]"
		} else if (src.includes("gui")) {
			srcClass = "log-src-gui"
			srcTag = "[gui]"
		}

		const timeStr = formatTime(line.at)
		const rawLines = line.text.split(/\r?\n/)

		for (let i = 0; i < rawLines.length; i++) {
			const sub = rawLines[i]
			if (i > 0 && i === rawLines.length - 1 && sub.trim() === "") continue

			const div = document.createElement("div")
			div.className = "log-row"
			div.dataset.search = `${srcTag.toLowerCase()} ${sub.toLowerCase()}`
			if (currentFilter && !div.dataset.search.includes(currentFilter)) {
				div.classList.add("hidden")
			}

			if (i === 0) {
				div.innerHTML = `<span class="log-t">${escapeHtml(timeStr)}</span><span class="log-src ${srcClass}">${escapeHtml(srcTag)}</span><span class="log-txt">${escapeHtml(sub)}</span>`
			} else {
				div.innerHTML = `<span class="log-t" style="visibility:hidden">${escapeHtml(timeStr)}</span><span class="log-src" style="visibility:hidden">${escapeHtml(srcTag)}</span><span class="log-txt">${escapeHtml(sub)}</span>`
			}
			logEl.appendChild(div)
		}
	}
	logEl.scrollTop = logEl.scrollHeight
}

async function refreshConfig() {
	const savedAllowTunnel = localStorage.getItem("allowTunnel") !== "false"
	if (els.allowTunnel) els.allowTunnel.checked = savedAllowTunnel

	const c = await window.localRepoMcp.config(env())
	if (els.mcpLocal) els.mcpLocal.value = c.mcpLocalUrl
	if (els.mcpPublic) els.mcpPublic.value = c.mcpPublicUrl || localStorage.getItem("mcpPublicUrl") || "https://mcp.wavycastic.id.vn/mcp"
	const mcpToken = c.mcpToken || localStorage.getItem("mcpToken") || ""
	if (els.mcpToken) els.mcpToken.value = mcpToken
	const mcpTokenInput = document.getElementById("MCP_TOKEN") as HTMLInputElement | null
	if (mcpTokenInput) mcpTokenInput.value = mcpToken
	if (els.mode) els.mode.textContent = "Local only"
}

function randomToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function saveCustomValues() {
	const allowTunnel = els.allowTunnel ? els.allowTunnel.checked : true
	const cfg = {
		mcpPublicUrl: els.mcpPublic ? els.mcpPublic.value.trim() : "",
		mcpToken: els.mcpToken ? els.mcpToken.value.trim() : "",
	}
	localStorage.setItem("mcpPublicUrl", cfg.mcpPublicUrl)
	localStorage.setItem("mcpToken", cfg.mcpToken)
	localStorage.setItem("allowTunnel", String(allowTunnel))
	const mcpTokenInput = document.getElementById("MCP_TOKEN") as HTMLInputElement | null
	if (mcpTokenInput && els.mcpToken) mcpTokenInput.value = els.mcpToken.value.trim()
	void window.localRepoMcp.saveConfig?.(cfg)
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
els.mcpToken?.addEventListener("input", saveCustomValues)
els.allowTunnel?.addEventListener("change", async () => {
	saveCustomValues()
	if (lastState.tunnel.running && !els.allowTunnel.checked) {
		appendLog({ at: new Date().toISOString(), source: "gui", text: "Stopping Cloudflare Tunnel (disabled by user)..." })
		await window.localRepoMcp.stopTunnel()
	} else if (!lastState.tunnel.running && els.allowTunnel.checked) {
		appendLog({ at: new Date().toISOString(), source: "gui", text: "Starting Cloudflare Tunnel (enabled by user)..." })
		await window.localRepoMcp.startTunnel()
	}
})

document.getElementById("start-all")?.addEventListener("click", async () => {
	saveCustomValues()
	if (!lastState.mcp.running) await window.localRepoMcp.startMcp(env())
	if (!lastState.tunnel.running && els.allowTunnel?.checked) await window.localRepoMcp.startTunnel()
})

document.getElementById("stop-all")?.addEventListener("click", async () => {
	if (lastState.mcp.running) await window.localRepoMcp.stopMcp()
	if (lastState.tunnel.running) await window.localRepoMcp.stopTunnel()
})

document.getElementById("toggle-mcp")?.addEventListener("click", async () => {
	saveCustomValues()
	if (lastState.mcp.running) await window.localRepoMcp.stopMcp()
	else await window.localRepoMcp.startMcp(env())
})
document.getElementById("toggle-tunnel")?.addEventListener("click", async () => {
	saveCustomValues()
	if (lastState.tunnel.running) await window.localRepoMcp.stopTunnel()
	else await window.localRepoMcp.startTunnel()
})
document.getElementById("copy-mcp-public")?.addEventListener("click", () => copy(els.mcpPublic.value))
document.getElementById("copy-mcp-token")?.addEventListener("click", () => copy(els.mcpToken.value))
document.getElementById("show-mcp-token")?.addEventListener("click", () => {
	els.mcpToken.type = els.mcpToken.type === "password" ? "text" : "password"
})
document.getElementById("save-custom")?.addEventListener("click", saveCustomValues)
document.getElementById("gen-mcp-token")?.addEventListener("click", () => {
	els.mcpToken.value = randomToken()
	saveCustomValues()
})
document.getElementById("clear")?.addEventListener("click", () => (logEl.innerHTML = ""))
document.getElementById("clear-log-btn")?.addEventListener("click", () => (logEl.innerHTML = ""))
document.getElementById("copy-log-all")?.addEventListener("click", () => copy(logEl.innerText))
document.getElementById("log-filter")?.addEventListener("input", (e) => {
	const query = (e.target as HTMLInputElement).value.toLowerCase().trim()
	const lines = logEl.querySelectorAll<HTMLElement>(".log-row")
	lines.forEach((el) => {
		const match = !query || (el.dataset.search ? el.dataset.search.includes(query) : true)
		el.classList.toggle("hidden", !match)
	})
})

window.localRepoMcp.onState(setState)
window.localRepoMcp.onLog((l) => appendLog(l))
window.localRepoMcp.onCommand?.((cmd) => {
	if (cmd === "start-all") document.getElementById("start-all")?.click()
	if (cmd === "stop-all") document.getElementById("stop-all")?.click()
})
window.localRepoMcp.state().then(setState)
refreshConfig().catch((e) => appendLog(`config error: ${e instanceof Error ? e.message : String(e)}`))

export {}

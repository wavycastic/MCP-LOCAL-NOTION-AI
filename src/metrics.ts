/**
 * P1 #12 — Structured Observability
 *
 * In-memory metrics store. Phản ánh mỷ ưu tiên vào structured logs,
 * không log source code, secrets hoặc raw terminal input.
 */

export type ToolMetric = {
	count: number
	errorCount: number
	totalDurationMs: number
	lastCalledAt: number | null
	lastErrorAt: number | null
	lastError: string | null
}

export type MetricsSnapshot = {
	startedAt: number
	uptimeSeconds: number
	tools: Record<string, ToolMetric>
	flowlens: {
		sidecarTimeouts: number
		sidecarCrashes: number
		sidecarParseErrors: number
	}
	pty: {
		sessionsOpened: number
		sessionsClosed: number
		bufferDrops: number
	}
}

const startedAt = Date.now()
const toolMetrics: Record<string, ToolMetric> = {}

const flowlensCounters = {
	timeouts: 0,
	crashes: 0,
	parseErrors: 0,
}

const ptyCounters = {
	open: 0,
	close: 0,
	bufferDrops: 0,
}

// ---------------------------------------------------------------------------
// Tool metrics
// ---------------------------------------------------------------------------

function getOrCreate(tool: string): ToolMetric {
	if (!toolMetrics[tool]) {
		toolMetrics[tool] = {
			count: 0,
			errorCount: 0,
			totalDurationMs: 0,
			lastCalledAt: null,
			lastErrorAt: null,
			lastError: null,
		}
	}
	return toolMetrics[tool]!
}

export function recordToolCall(tool: string, durationMs: number, success: boolean, error?: string): void {
	const m = getOrCreate(tool)
	m.count++
	m.totalDurationMs += durationMs
	m.lastCalledAt = Date.now()
	if (!success) {
		m.errorCount++
		m.lastErrorAt = Date.now()
		m.lastError = error ? error.slice(0, 200) : "unknown error"
	}
}

// ---------------------------------------------------------------------------
// FlowLens sidecar metrics
// ---------------------------------------------------------------------------

export function recordFlowLensTimeout(): void { flowlensCounters.timeouts++ }
export function recordFlowLensCrash(): void { flowlensCounters.crashes++ }
export function recordFlowLensParseError(): void { flowlensCounters.parseErrors++ }

// ---------------------------------------------------------------------------
// PTY metrics
// ---------------------------------------------------------------------------

export function recordPtyOpen(): void { ptyCounters.open++ }
export function recordPtyClose(): void { ptyCounters.close++ }
export function recordPtyBufferDrop(): void { ptyCounters.bufferDrops++ }

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function getMetricsSnapshot(): MetricsSnapshot {
	return {
		startedAt,
		uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
		tools: { ...toolMetrics },
		flowlens: {
			sidecarTimeouts: flowlensCounters.timeouts,
			sidecarCrashes: flowlensCounters.crashes,
			sidecarParseErrors: flowlensCounters.parseErrors,
		},
		pty: {
			sessionsOpened: ptyCounters.open,
			sessionsClosed: ptyCounters.close,
			bufferDrops: ptyCounters.bufferDrops,
		},
	}
}

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
	pty: {
		sessionsOpened: number
		sessionsClosed: number
		bufferDrops: number
	}
}

const startedAt = Date.now()
const toolMetrics: Record<string, ToolMetric> = {}

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
		pty: {
			sessionsOpened: ptyCounters.open,
			sessionsClosed: ptyCounters.close,
			bufferDrops: ptyCounters.bufferDrops,
		},
	}
}

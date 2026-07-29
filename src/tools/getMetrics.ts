import { getMetricsSnapshot } from "../metrics.js"

export const getMetricsSchema = {}

export async function getMetrics(_args: unknown) {
	return getMetricsSnapshot()
}

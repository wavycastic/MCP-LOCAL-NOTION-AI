import { checkHealth, checkReadiness } from "../health.js"

export const healthCheckSchema = {}
export const readinessCheckSchema = {}

export async function healthCheck(_args: unknown) {
	return checkHealth()
}

export async function readinessCheck(_args: unknown) {
	return checkReadiness()
}

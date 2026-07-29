/**
 * P1 #11 — Health và Readiness
 *
 * health_check : process còn sống (luôn OK nếu server đang chạy)
 * readiness_check : config hợp lệ, repo registry load được, FlowLens compatible
 */

import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { allRepos, type Repo } from "./repos.js"
import { probeFlowLens } from "./flowlens.js"
import { REPOS_CONFIG, ALLOW_FULL_ACCESS, ALLOW_TERMINAL } from "./config.js"

// ---------------------------------------------------------------------------
// Health (liveness)
// ---------------------------------------------------------------------------

export type HealthResult = {
	ok: true
	uptime: number
	pid: number
	nodeVersion: string
}

export function checkHealth(): HealthResult {
	return {
		ok: true,
		uptime: Math.round(process.uptime()),
		pid: process.pid,
		nodeVersion: process.version,
	}
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type RepoReadiness = {
	name: string
	root: string
	write: boolean
	gitValid: boolean
	flowlensIndexPresent: boolean
	pendingQueueDepth: number
	toolchain: string
	source: string
}

export type ReadinessResult = {
	ready: boolean
	configLoaded: boolean
	configPath: string
	repos: RepoReadiness[]
	flowlens: {
		available: boolean
		version?: string
		protocolVersion?: number
		capabilities?: string[]
		error?: string
	}
	security: {
		allowFullAccess: boolean
		allowTerminal: boolean
	}
	errors: string[]
}

export async function checkReadiness(): Promise<ReadinessResult> {
	const errors: string[] = []

	// 1. Config
	let configLoaded = false
	let repos: Repo[] = []
	try {
		repos = allRepos()
		configLoaded = true
	} catch (e) {
		errors.push(`repo config error: ${String(e)}`)
	}

	// 2. Per-repo readiness
	const repoReadiness: RepoReadiness[] = repos.map((repo) => {
		const gitDir = repo.root !== "__FULL_ACCESS__" ? join(repo.root, ".git") : null
		const gitValid = gitDir ? existsSync(gitDir) : true

		const flowlensDir = repo.root !== "__FULL_ACCESS__" ? join(repo.root, ".flowlens") : null
		const flowlensIndexPresent = flowlensDir ? existsSync(flowlensDir) : false

		let pendingQueueDepth = 0
		if (flowlensDir) {
			try {
				const queuePath = join(flowlensDir, "pending-index.jsonl")
				if (existsSync(queuePath)) {
					const stat = statSync(queuePath)
					// Rough estimate: each line ~100 bytes
					pendingQueueDepth = Math.max(0, Math.round(stat.size / 100))
				}
			} catch { /* ignore */ }
		}

		if (!gitValid) errors.push(`repo "${repo.name}": .git directory not found`)

		return {
			name: repo.name,
			root: repo.root,
			write: repo.write,
			gitValid,
			flowlensIndexPresent,
			pendingQueueDepth,
			toolchain: repo.toolchain,
			source: repo.source,
		}
	})

	// 3. FlowLens probe
	const probe = await probeFlowLens()
	const flowlensInfo = probe.available
		? {
				available: true,
				version: probe.version,
				protocolVersion: probe.protocolVersion,
				capabilities: probe.capabilities,
			}
		: {
				available: false,
				error: probe.error,
			}

	// FlowLens unavailable is a warning, not a hard failure (execution tools still work)
	if (!probe.available) {
		errors.push(`FlowLens sidecar: ${probe.error}`)
	}

	const ready = configLoaded && repos.length > 0 && repoReadiness.every((r) => r.gitValid)

	return {
		ready,
		configLoaded,
		configPath: REPOS_CONFIG,
		repos: repoReadiness,
		flowlens: flowlensInfo,
		security: {
			allowFullAccess: ALLOW_FULL_ACCESS,
			allowTerminal: ALLOW_TERMINAL,
		},
		errors,
	}
}

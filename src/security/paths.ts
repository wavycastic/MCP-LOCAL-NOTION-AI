import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { REPO_ROOT } from "../config.js"

const DENY: RegExp[] = [
	/(^|\/)\.env(\..*)?$/,
	/(^|\/)\.git\/(config|credentials)$/,
	/\.(pem|key|pfx|p12|jks)$/i,
	/(^|\/)secrets?(\/|$)/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
	/(^|\/)\.npmrc$/,
]

export class PathDenied extends Error {}

/**
 * Core: resolve `rel` vao trong REPO_ROOT, chan symlink escape va deny-list.
 * Hoat dong ca khi path chua ton tai: realpath ancestor gan nhat roi ghep lai duoi.
 */
function resolveInRoot(rel: string): string {
	if (typeof rel !== "string" || rel.length === 0)
		throw new PathDenied("path required")
	if (rel.includes("\0")) throw new PathDenied("invalid path")
	if (isAbsolute(rel)) throw new PathDenied("path must be relative to repo root")

	const target = resolve(REPO_ROOT, rel)

	let anc = target
	const tail: string[] = []
	while (!existsSync(anc)) {
		const parent = dirname(anc)
		if (parent === anc) throw new PathDenied("path escapes repo root")
		tail.unshift(basename(anc))
		anc = parent
	}

	const real = tail.length === 0
		? realpathSync(anc)
		: resolve(realpathSync(anc), ...tail)

	const r = relative(REPO_ROOT, real)
	if (r === "" || r.startsWith("..") || isAbsolute(r))
		throw new PathDenied("path escapes repo root")

	const norm = r.split(sep).join("/")
	for (const p of DENY) {
		if (p.test(norm)) throw new PathDenied(`denied path: ${norm}`)
	}
	return real
}

/** Path phai TON TAI. Dung cho read_file, edit_file, git_blame, git_diff. */
export function safeResolve(rel: string): string {
	const abs = resolveInRoot(rel)
	if (!existsSync(abs)) throw new PathDenied(`not found: ${rel}`)
	return abs
}

/** Path CHUA CAN ton tai. Dung cho create_file, move_file (dich). */
export function safeResolveNew(rel: string): string {
	return resolveInRoot(rel)
}

/** Nhu safeResolve nhung cho phep chinh repo root ("." hoac ""). Chi dung cho doc thu muc. */
export function safeResolveDir(rel?: string): string {
	const r = (rel ?? ".").trim()
	if (r === "" || r === "." || r === "./") return REPO_ROOT
	return safeResolve(r)
}

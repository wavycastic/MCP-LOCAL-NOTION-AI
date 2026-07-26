import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
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

/** Tra ve absolute path da verify, hoac throw. `rel` phai la duong dan tuong doi. */
export function safeResolve(rel: string): string {
	if (typeof rel !== "string" || rel.length === 0)
		throw new PathDenied("path required")
	if (rel.includes("\0")) throw new PathDenied("invalid path")
	if (isAbsolute(rel)) throw new PathDenied("path must be relative to repo root")

	const target = resolve(REPO_ROOT, rel)

	// Chan symlink tro ra ngoai: realpath chinh no, hoac parent neu file chua ton tai.
	let real: string
	try {
		real = realpathSync(target)
	} catch {
		real = resolve(realpathSync(resolve(target, "..")), target.split(sep).pop()!)
	}

	const r = relative(REPO_ROOT, real)
	if (r === "" || r.startsWith("..") || isAbsolute(r))
		throw new PathDenied("path escapes repo root")

	const norm = r.split(sep).join("/")
	for (const p of DENY) {
		if (p.test(norm)) throw new PathDenied(`denied path: ${norm}`)
	}
	return real
}

/** Nhu safeResolve nhung cho phep chinh repo root ("." hoac ""). Chi dung cho doc thu muc. */
export function safeResolveDir(rel?: string): string {
	const r = (rel ?? ".").trim()
	if (r === "" || r === "." || r === "./") return REPO_ROOT
	return safeResolve(r)
}

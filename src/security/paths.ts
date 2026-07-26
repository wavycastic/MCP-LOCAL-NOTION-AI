import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

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
 * Core: resolve `rel` vao trong `root` (root cua MOT repo), chan symlink escape
 * va deny-list. Hoat dong ca khi path chua ton tai: realpath ancestor gan nhat
 * roi ghep lai phan duoi.
 *
 * Moi tool phai di qua ham nay. Root luon la repo dang lam viec, khong bao gio
 * la WORKSPACE_ROOT — nho vay khong the doc cheo tu repo A sang repo B bang "../".
 */
function resolveInRoot(root: string, rel: string): string {
	if (typeof rel !== "string" || rel.length === 0)
		throw new PathDenied("path required")
	if (rel.includes("\0")) throw new PathDenied("invalid path")
	if (isAbsolute(rel)) throw new PathDenied("path must be relative to repo root")

	const target = resolve(root, rel)

	let anc = target
	const tail: string[] = []
	while (!existsSync(anc)) {
		const parent = dirname(anc)
		if (parent === anc) throw new PathDenied("path escapes repo root")
		tail.unshift(basename(anc))
		anc = parent
	}

	const real =
		tail.length === 0 ? realpathSync(anc) : resolve(realpathSync(anc), ...tail)

	const r = relative(root, real)
	if (r === "" || r.startsWith("..") || isAbsolute(r))
		throw new PathDenied("path escapes repo root")

	const norm = r.split(sep).join("/")
	for (const p of DENY) {
		if (p.test(norm)) throw new PathDenied(`denied path: ${norm}`)
	}
	return real
}

/** Path phai TON TAI. Dung cho read_file, edit_file, git_blame, git_diff. */
export function safeResolve(root: string, rel: string): string {
	const abs = resolveInRoot(root, rel)
	if (!existsSync(abs)) throw new PathDenied(`not found: ${rel}`)
	return abs
}

/** Path CHUA CAN ton tai. Dung cho create_file va dich cua move_file. */
export function safeResolveNew(root: string, rel: string): string {
	return resolveInRoot(root, rel)
}

/** Nhu safeResolve nhung cho phep chinh repo root ("." hoac ""). Chi dung cho doc thu muc. */
export function safeResolveDir(root: string, rel?: string): string {
	const r = (rel ?? ".").trim()
	if (r === "" || r === "." || r === "./") return root
	return safeResolve(root, r)
}

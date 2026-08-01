import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

export const FULL_ACCESS_ROOT = "__FULL_ACCESS__"

const DENY: RegExp[] = [
	// Chan .env, .env.local, .env.production... nhung KHONG chan file template.
	// Truoc day pattern la /(^|\/)\.env(\..*)?$/ nen no chan ca `.env.example` —
	// mot file da commit cong khai, khong co bi mat nao. Ket qua: khong sua noi
	// tai lieu cau hinh cua chinh repo nay bang tool cua chinh no.
	/(^|\/)\.env(?!\.(example|sample|template)$)(\..*)?$/,
	/(^|\/)\.git\/(config|credentials)$/,
	// .git/hooks/ can be weaponised for code execution — deny all hook scripts
	/(^|\/)\.git\/hooks\//,
	/\.(pem|key|pfx|p12|jks)$/i,
	/(^|\/)secrets?(\/|$)/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
	/(^|\/)\.npmrc$/,
	// SSH keys and known_hosts
	/(^|\/)(\.ssh)(\/|$)/i,
	/(^|\/)known_hosts$/,
]

export class PathDenied extends Error {}

/**
 * Kiem tra mot path tuong doi co roi vao deny-list khong.
 *
 * Tach ra rieng vi khong phai luc nao cung co path de resolve: git_commit can
 * loc danh sach ten file da stage do git in ra.
 */
export function isDeniedRelPath(rel: string): boolean {
	const norm = rel.split(sep).join("/")
	return DENY.some((p) => p.test(norm))
}

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
	if (root === FULL_ACCESS_ROOT) return isAbsolute(rel) ? resolve(rel) : resolve(process.cwd(), rel)
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

	if (isDeniedRelPath(r)) throw new PathDenied(`denied path: ${r}`)
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
	if (root === FULL_ACCESS_ROOT) {
		const abs = r === "" || r === "." || r === "./" ? process.cwd() : resolveInRoot(root, r)
		if (!existsSync(abs)) throw new PathDenied(`not found: ${r}`)
		return abs
	}
	if (r === "" || r === "." || r === "./") return root
	return safeResolve(root, r)
}

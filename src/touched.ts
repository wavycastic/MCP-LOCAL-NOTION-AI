/**
 * Ghi nho nhung file ma CAC TOOL NAY da sua, theo tung repo.
 *
 * Ly do ton tai: `git add -A` gom moi thay doi trong working tree, tuc la commit
 * cua agent keo theo ca thay doi ban dang lam do trong cung repo. Chuyen do xay
 * ra hang ngay khi vua tu code vua de agent sua. Co danh sach nay thi git_commit
 * stage dung phan agent lam, khong hon.
 */

const touched = new Map<string, Set<string>>()

export function noteTouched(root: string, ...paths: string[]): void {
	let set = touched.get(root)
	if (!set) {
		set = new Set()
		touched.set(root, set)
	}
	for (const p of paths) if (p) set.add(p)
}

/** Bo path khoi danh sach — dung khi thay doi da bi hoan tac (git_restore). */
export function forgetTouched(root: string, ...paths: string[]): void {
	const set = touched.get(root)
	if (!set) return
	for (const p of paths) set.delete(p)
}

export function peekTouched(root: string): string[] {
	return [...(touched.get(root) ?? [])]
}

/** Goi sau khi commit THANH CONG: nhung file do da vao history. */
export function clearTouched(root: string): void {
	touched.delete(root)
}

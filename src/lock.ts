/**
 * Mutex don gian, serialize cac tool co side effect (edit/create/move/remove,
 * build/test, commit/push, reindex).
 *
 * Ly do: agent goi tool song song rat de gay race — vd edit_file trong khi
 * run_build dang doc file, hoac hai git_commit chay chong len nhau.
 */

let tail: Promise<unknown> = Promise.resolve()
let holder: string | null = null
let queued = 0

export function lockState() {
	return { holder, queued }
}

export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	queued++
	const result = tail.then(async () => {
		queued--
		holder = name
		try {
			return await fn()
		} finally {
			holder = null
		}
	})
	// Giu chuoi khong bi vo khi 1 tool throw.
	tail = result.then(
		() => undefined,
		() => undefined,
	)
	return result
}

/**
 * Mutex theo TUNG REPO. Tool co side effect tren cung mot repo chay tuan tu;
 * hai repo khac nhau chay song song binh thuong.
 *
 * Ly do: agent goi tool song song rat de gay race — vd edit_file trong khi
 * run_build dang doc file, hoac hai git_commit chong len nhau.
 */

type Lane = { tail: Promise<unknown>; holder: string | null; queued: number }

const lanes = new Map<string, Lane>()

function lane(key: string): Lane {
	let l = lanes.get(key)
	if (!l) {
		l = { tail: Promise.resolve(), holder: null, queued: 0 }
		lanes.set(key, l)
	}
	return l
}

export function lockState() {
	return [...lanes.entries()]
		.filter(([, l]) => l.holder !== null || l.queued > 0)
		.map(([repo, l]) => ({ repo, holder: l.holder, queued: l.queued }))
}

export function withLock<T>(
	repoKey: string,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	const l = lane(repoKey)
	l.queued++
	const result = l.tail.then(async () => {
		l.queued--
		l.holder = name
		try {
			return await fn()
		} finally {
			l.holder = null
		}
	})
	// Giu chuoi khong bi vo khi 1 tool throw.
	l.tail = result.then(
		() => undefined,
		() => undefined,
	)
	return result
}

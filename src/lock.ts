/**
 * Mutex theo TUNG REPO. Tool co side effect tren cung mot repo chay tuan tu;
 * hai repo khac nhau chay song song binh thuong.
 *
 * Ly do: agent goi tool song song rat de gay race — vd edit_file trong khi
 * run_build dang doc file, hoac hai git_commit chong len nhau.
 */
import { LOCK_WAIT_MS } from "./config.js"

type Lane = { tail: Promise<void>; holder: string | null; queued: number }

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

/** `p` khong bao gio reject. Reject o day chi co nghia la het thoi gian cho. */
function waitFor(p: Promise<void>, ms: number): Promise<void> {
	if (!Number.isFinite(ms) || ms <= 0) return p // 0 = cho vo han (job background)
	return new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error("lock-timeout")), ms)
		p.then(
			() => {
				clearTimeout(t)
				res()
			},
			() => {
				clearTimeout(t)
				res()
			},
		)
	})
}

export async function withLock<T>(
	repoKey: string,
	name: string,
	fn: () => Promise<T>,
	waitMs: number = LOCK_WAIT_MS,
): Promise<T> {
	const l = lane(repoKey)

	const prev = l.tail
	let release!: () => void
	l.tail = new Promise<void>((res) => {
		release = res
	})
	l.queued++

	try {
		await waitFor(prev, waitMs)
	} catch {
		// Het gio cho: KHONG chiem lane. Phai mo cho nguoi sau dung luc prev xong,
		// khong duoc release ngay — lam vay la pha thu tu tuan tu cua ca lane.
		void prev.then(release, release)
		l.queued--
		const busy = l.holder ? `dang chay "${l.holder}"` : "dang co viec khac chay"
		throw new Error(
			`het thoi gian cho repo ranh (${Math.round(waitMs / 1000)}s): repo ${busy}. ` +
				`Neu do la build/test dai, dat background=true va theo doi bang job_status`,
		)
	}

	l.queued--
	l.holder = name
	try {
		return await fn()
	} finally {
		l.holder = null
		release()
	}
}

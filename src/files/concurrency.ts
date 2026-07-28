/** Ordered, bounded-concurrency mapper for local filesystem work. */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return []
	const concurrency = Math.max(1, Math.min(Math.floor(limit), items.length))
	const results = new Array<R>(items.length)
	let cursor = 0

	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (true) {
				const index = cursor++
				if (index >= items.length) return
				results[index] = await worker(items[index]!, index)
			}
		}),
	)

	return results
}

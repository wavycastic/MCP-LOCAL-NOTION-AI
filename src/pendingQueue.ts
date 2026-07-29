/**
 * Durable pending-index queue — mỗi repo có một file:
 *   <repo_root>/.flowlens/pending-index.jsonl
 *
 * Mỗi dòng là một JSON entry: { files: string[], enqueuedAt: string }
 * File chỉ bị xoá sau khi FlowLens xác nhận generation mới.
 * Khi server khởi động lại, queue được replay để không mất file cần index.
 *
 * Thiết kế:
 * - enqueueFiles: append vào file (tạo thư mục nếu chưa có), dedup theo Set
 * - peekQueue:    đọc tất cả file pending (dedup)
 * - clearQueue:   xoá file queue (chỉ gọi sau generation confirmed)
 * - queueDepth:   trả số file đang chờ (cho changedFilesPending)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const QUEUE_FILE = ".flowlens/pending-index.jsonl"

type QueueEntry = { files: string[]; enqueuedAt: string }

function queuePath(repoRoot: string): string {
	return join(repoRoot, QUEUE_FILE)
}

/**
 * Ghi các file vào queue bền vững trước khi gọi FlowLens.
 * Dedup theo Set để không lưu trùng trong cùng một lần enqueue.
 * Nếu files rỗng sau dedup thì không ghi.
 */
export function enqueueFiles(repoRoot: string, files: string[]): void {
	const unique = [...new Set(files.filter(Boolean))]
	if (unique.length === 0) return
	const qp = queuePath(repoRoot)
	try {
		mkdirSync(dirname(qp), { recursive: true })
		const entry: QueueEntry = { files: unique, enqueuedAt: new Date().toISOString() }
		appendFileSync(qp, JSON.stringify(entry) + "\n", "utf8")
	} catch (e) {
		// Không để lỗi ghi queue làm hỏng tool response
		console.error(`[pendingQueue] enqueueFiles failed for ${repoRoot}:`, e)
	}
}

/**
 * Đọc toàn bộ file pending trong queue (dedup theo tên file).
 * Trả mảng rỗng nếu không có queue.
 */
export function peekQueue(repoRoot: string): string[] {
	const qp = queuePath(repoRoot)
	if (!existsSync(qp)) return []
	try {
		const raw = readFileSync(qp, "utf8")
		const allFiles = new Set<string>()
		for (const line of raw.split("\n")) {
			const trimmed = line.trim()
			if (!trimmed) continue
			try {
				const entry = JSON.parse(trimmed) as QueueEntry
				if (Array.isArray(entry.files)) {
					for (const f of entry.files) if (f) allFiles.add(f)
				}
			} catch {
				// dòng corrupt: bỏ qua, không crash
			}
		}
		return [...allFiles]
	} catch (e) {
		console.error(`[pendingQueue] peekQueue failed for ${repoRoot}:`, e)
		return []
	}
}

/**
 * Số file đang chờ index. 0 nếu không có queue.
 */
export function queueDepth(repoRoot: string): number {
	return peekQueue(repoRoot).length
}

/**
 * Xoá queue sau khi FlowLens xác nhận generation mới thành công.
 * Bỏ qua lỗi nếu file không tồn tại.
 */
export function clearQueue(repoRoot: string): void {
	const qp = queuePath(repoRoot)
	if (!existsSync(qp)) return
	try {
		rmSync(qp)
	} catch (e) {
		console.error(`[pendingQueue] clearQueue failed for ${repoRoot}:`, e)
	}
}

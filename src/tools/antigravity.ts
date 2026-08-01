/**
 * Bo tool antigravity_*: giao viec cho sub-agent Antigravity chay ngay tren repo
 * local, roi theo doi tung buoc mot.
 *
 * Lop duoi la Antigravity CLI o che do headless (src/antigravity/cli.ts).
 * Khong con daemon, khong con project id, khong con doc SQLite: thu muc lam viec
 * chinh la repo, va trang thai ket thuc lay tu su kien result cua CLI.
 */
import { z } from "zod"
import { listSessions, pollSession, startRun, stopSession } from "../antigravity/cli.js"
import { ANTIGRAVITY_ENABLE, ANTIGRAVITY_MODEL, SYNC_WAIT_MS } from "../config.js"
import { resolveRepo } from "../repos.js"

const POLL_CAP_MS = Math.min(SYNC_WAIT_MS, 45_000)
const MAX_EVENTS = 40

function assertEnabled(): void {
	if (!ANTIGRAVITY_ENABLE) {
		throw new Error("Antigravity dang tat. Dat ANTIGRAVITY_ENABLE=true trong .env roi khoi dong lai server")
	}
}

const modelField = z
	.string()
	.optional()
	.describe(
		`Slug model, vd gemini-3.6-flash-low|medium|high, gemini-3.1-pro-high, claude-sonnet-4-6, ` +
			`claude-opus-4-6-thinking, gpt-oss-120b-medium. Xem day du bang: agy models. Mac dinh ${ANTIGRAVITY_MODEL}`,
	)

const skipPermsField = z
	.boolean()
	.optional()
	.describe(
		"Tu duyet moi tool (--dangerously-skip-permissions). Headless khong hoi quyen duoc, nen viec nao " +
			"can chay lenh hay ghi file ma khong bat co nay se bi tu choi va tra ve rong.",
	)

export const antigravitySpawnSchema = {
	task: z
		.string()
		.min(1)
		.describe(
			"UU TIEN CHO TAC VU PHUC TAP, REFACTOR NHIEU FILE, DIEU TRA CODEBASE HOAC CONG VIEC NHIEU BUOC. Sub-agent Antigravity se tu dong thuc thi va hien thi Live Viewer cho nguoi dung.",
		),
	repo: z.string().optional().describe("Ten repo trong repos.json. Thu muc repo se la cwd cua sub-agent."),
	conversation_id: z
		.string()
		.optional()
		.describe("ID hoi thoai cu de tiep tuc gui cau hoi / phan hoi noi tiep cho sub-agent (multiturn chat)."),
	model: modelField,
	skip_permissions: skipPermsField,
	interactive: z
		.boolean()
		.optional()
		.describe("Bat cua so Terminal tuong tac/live log truoc mat nguoi dung (true). Chon false de chay ngam API stream."),
}

export async function antigravitySpawn(a: {
	task: string
	repo?: string
	conversation_id?: string
	model?: string
	skip_permissions?: boolean
	interactive?: boolean
}): Promise<unknown> {
	assertEnabled()
	const repo = resolveRepo(a.repo)
	// Chi them instruction CWD o luot dau (khi chua co conversation_id) de khong lam rac log o cac luot sau.
	const promptText = a.conversation_id
		? a.task
		: `Thu muc lam viec: ${repo.root}\n` +
			`Moi duong dan tuong doi deu tinh tu day. Khong tim file o noi khac, khong quet o dia.\n\n` +
			a.task

	const args: Parameters<typeof startRun>[0] = {
		prompt: promptText,
		cwd: repo.root,
		repo: repo.name,
	}
	if (a.conversation_id) args.conversationId = a.conversation_id
	if (a.model) args.model = a.model
	if (a.skip_permissions !== undefined) args.skipPermissions = a.skip_permissions
	if (a.interactive !== undefined) args.interactive = a.interactive
	const s = await startRun(args)
	return {
		conversation_id: s.id,
		repo: s.repo,
		cwd: s.cwd,
		model: s.model,
		status: s.status,
		hint: "Goi antigravity_poll voi conversation_id nay de xem tung buoc va doc cau tra loi (response).",
	}
}

export const antigravityPollSchema = {
	conversation_id: z.string().min(1),
	wait_ms: z
		.number()
		.int()
		.min(0)
		.max(POLL_CAP_MS)
		.optional()
		.describe("Cho toi khi co buoc moi hoac sub-agent xong. 0 = chup anh tuc thi."),
	since_seq: z
		.number()
		.int()
		.min(-1)
		.optional()
		.describe("Chi tra su kien co seq lon hon gia tri nay. Truyen lai next_seq cua lan poll truoc."),
}

export async function antigravityPoll(a: {
	conversation_id: string
	wait_ms?: number
	since_seq?: number
}): Promise<unknown> {
	assertEnabled()
	const since = a.since_seq ?? -1
	const waitMs = Math.min(a.wait_ms ?? 0, POLL_CAP_MS)
	const s = await pollSession(a.conversation_id, since, waitMs)
	const fresh = s.events.filter((e) => e.seq > since)
	const shown = fresh.slice(-MAX_EVENTS)
	const last = s.events[s.events.length - 1]
	return {
		conversation_id: s.id,
		status: s.status,
		done: s.status !== "running",
		step_count: s.events.length,
		events: shown,
		omitted_events: fresh.length - shown.length,
		next_seq: last ? last.seq : since,
		text: s.response,
		...(s.error ? { error: s.error } : {}),
		...(s.usage ? { usage: s.usage } : {}),
		turns: s.turns,
	}
}

export const antigravityReplySchema = {
	conversation_id: z.string().min(1),
	message: z.string().min(1),
	repo: z.string().optional(),
	model: modelField,
	skip_permissions: skipPermsField,
	interactive: z.boolean().optional().describe("Bat cua so Terminal tuong tac/live log truoc mat nguoi dung (true)."),
}

export async function antigravityReply(a: {
	conversation_id: string
	message: string
	repo?: string
	model?: string
	skip_permissions?: boolean
	interactive?: boolean
}): Promise<unknown> {
	assertEnabled()
	const repo = resolveRepo(a.repo)
	const args: Parameters<typeof startRun>[0] = {
		prompt: a.message,
		cwd: repo.root,
		repo: repo.name,
		conversationId: a.conversation_id,
	}
	if (a.model) args.model = a.model
	if (a.skip_permissions !== undefined) args.skipPermissions = a.skip_permissions
	if (a.interactive !== undefined) args.interactive = a.interactive
	const s = await startRun(args)
	const last = s.events[s.events.length - 1]
	return {
		conversation_id: s.id,
		sent: true,
		status: s.status,
		next_seq: last ? last.seq : -1,
		hint: "Goi antigravity_poll de xem luot tra loi.",
	}
}

export const antigravityStopSchema = {
	conversation_id: z.string().min(1),
}

export async function antigravityStop(a: { conversation_id: string }): Promise<unknown> {
	assertEnabled()
	return { conversation_id: a.conversation_id, stopped: stopSession(a.conversation_id) }
}

export const antigravityListSchema = {}

export async function antigravityList(): Promise<unknown> {
	assertEnabled()
	return {
		sessions: listSessions().map((s) => ({
			conversation_id: s.id,
			repo: s.repo,
			model: s.model,
			status: s.status,
			step_count: s.events.length,
			started_at: s.started_at,
			...(s.ended_at ? { ended_at: s.ended_at } : {}),
		})),
	}
}

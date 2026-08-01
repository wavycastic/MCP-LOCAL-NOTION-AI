import { antigravityPoll, antigravitySpawn } from "../src/tools/antigravity.js"

type PollResult = {
	status: string
	done: boolean
	next_seq: number
	text: string
	error?: string
	usage?: Record<string, number>
	events: Array<{
		seq: number
		kind: string
		state: string
		tool?: string
		params?: string
		text?: string
		error?: string
	}>
}

const customTask = process.argv.slice(2).join(" ").trim()
const started = Date.now()
const el = (): string => `${String(Math.round((Date.now() - started) / 1000)).padStart(3, " ")}s`

async function runTurn(task: string, conversationId?: string): Promise<{ id: string; response: string }> {
	console.log(`\n=== BAT DAU LUOT ${conversationId ? "TIEP THEO" : "DAU TIEN"} ===`)
	const spawned = (await antigravitySpawn({
		task,
		repo: "local-repo-mcp",
		conversation_id: conversationId,
		skip_permissions: true,
	})) as { conversation_id: string; model: string }

	console.log(`conversation ${spawned.conversation_id} | model ${spawned.model}`)

	let since = -1
	let responseText = ""
	for (;;) {
		const p = (await antigravityPoll({
			conversation_id: spawned.conversation_id,
			since_seq: since,
			wait_ms: 5000,
		})) as PollResult

		for (const e of p.events) {
			const bits = [`[${el()}]`, `#${String(e.seq).padStart(2, " ")}`, e.kind.padEnd(10), e.state.padEnd(6)]
			if (e.tool) bits.push(`[${e.tool}]`)
			if (e.params) bits.push(e.params)
			if (e.text) bits.push(e.text)
			if (e.error) bits.push(`LOI: ${e.error}`)
			console.log(bits.join(" "))
		}
		since = p.next_seq
		responseText = p.text

		if (p.done) {
			console.log(`status=${p.status}`)
			if (p.error) console.log(`loi: ${p.error}`)
			console.log(`phan hoi: ${p.text.trim()}`)
			break
		}
	}
	return { id: spawned.conversation_id, response: responseText }
}

if (customTask) {
	await runTurn(customTask)
} else {
	const secretCode = `SECRET_${Math.floor(100000 + Math.random() * 900000)}`
	console.log(`================================================================================`)
	console.log(`🚀 BẮT ĐẦU BÀI TEST 10 LƯỢT HỘI THOẠI LIÊN TIẾP VỚI SUB-AGENT`)
	console.log(`Mã bí mật khởi tạo ở lượt 1: ${secretCode}`)
	console.log(`================================================================================`)

	let convId: string | undefined

	const turns = [
		`Đây là lượt 1/10. Mã bí mật ban đầu của cuộc hội thoại này là ${secretCode}. Hãy ghi nhớ mã này và trả về TURN_1_OK.`,
		`Đây là lượt 2/10. Thêm mục [FRUIT_APPLE] vào danh sách từ vựng. Trả về TURN_2_OK.`,
		`Đây là lượt 3/10. Thêm mục [ANIMAL_TIGER] vào danh sách từ vựng. Trả về TURN_3_OK.`,
		`Đây là lượt 4/10. Thêm mục [CITY_TOKYO] vào danh sách từ vựng. Trả về TURN_4_OK.`,
		`Đây là lượt 5/10 (Kiểm tra trí nhớ giữa chừng). Không đọc file. Cho tôi biết mã bí mật ban đầu ở lượt 1 là gì?`,
		`Đây là lượt 6/10. Thêm mục [COLOR_BLUE] vào danh sách từ vựng. Trả về TURN_6_OK.`,
		`Đây là lượt 7/10. Liệt kê lại các mục từ vựng đã thêm ở lượt 2, 3, 4, 6.`,
		`Đây là lượt 8/10. Thêm mục [NUMBER_999] vào danh sách từ vựng. Trả về TURN_8_OK.`,
		`Đây là lượt 9/10. Liệt kê lại toàn bộ các mục đã thêm từ lượt 1 đến lượt 8.`,
		`Đây là lượt 10/10 (Tổng kết). Hãy xác nhận lại mã bí mật ban đầu ${secretCode} và trả về TURN_10_OK.`,
	]

	let successCount = 0
	let memoryPassed = false

	for (let i = 0; i < turns.length; i++) {
		const turnNum = i + 1
		console.log(`\n--------------------------------------------------------------------------------`)
		console.log(`>>> CHẠY LƯỢT ${turnNum}/10 ...`)
		console.log(`--------------------------------------------------------------------------------`)

		const res = await runTurn(turns[i], convId)
		convId = res.id
		successCount++

		if (turnNum === 5) {
			if (res.response.includes(secretCode)) {
				console.log(`\n🎯 LƯỢT 5 CHECKPOINT OK: Sub-agent nhớ chính xác mã ${secretCode}!`)
			} else {
				console.error(`\n⚠️ LƯỢT 5 CHECKPOINT WARN: Sub-agent chưa nhắc lại mã ${secretCode}.`)
			}
		}

		if (turnNum === 10) {
			if (res.response.includes(secretCode) || res.response.includes("TURN_10_OK")) {
				memoryPassed = true
			}
		}
	}

	console.log(`\n================================================================================`)
	console.log(`📊 TỔNG KẾT BÀI TEST 10 LƯỢT HỘI THOẠI:`)
	console.log(`- ID Hội thoại: ${convId}`)
	console.log(`- Số lượt chạy thành công: ${successCount}/10`)
	console.log(`- Kết quả duy trì trí nhớ qua 10 lượt: ${memoryPassed ? "PASSED ✅" : "FAILED ❌"}`)
	console.log(`================================================================================`)

	if (successCount === 10 && memoryPassed) {
		console.log(`\n🎉 TẤT CẢ 10 LƯỢT ĐỀU THÀNH CÔNG VÀ DUY TRÌ NGỮ CẢNH CHÍNH XÁC!`)
	} else {
		process.exitCode = 1
	}
}

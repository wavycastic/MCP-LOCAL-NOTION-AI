import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { EXEC_TIMEOUT_MS, MAX_OUTPUT } from "./config.js"
import { FULL_ACCESS_ROOT } from "./security/paths.js"

export type ExecResult = {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

function resolveCmd(cmd: string): string {
	if (process.platform !== "win32") return cmd
	if (cmd.endsWith(".exe") || cmd.endsWith(".cmd") || cmd.endsWith(".bat")) return cmd

	const pathDirs = (process.env.PATH ?? "").split(";").filter(Boolean)
	for (const ext of [".cmd", ".bat", ".exe"]) {
		if (cmd.includes("/") || cmd.includes("\\")) {
			if (existsSync(cmd + ext)) return cmd + ext
		} else {
			for (const dir of pathDirs) {
				if (existsSync(join(dir, cmd + ext))) return cmd + ext
			}
		}
	}
	return cmd
}

/**
 * Builtin cua cmd.exe, khong ton tai duoi dang file .exe.
 *
 * Co y giu that ngan: moi ten trong day la mot lenh phai di vong qua cmd.exe, ma
 * cmd.exe la thu duy nhat trong ca file nay con dien giai ky tu dac biet. `del`,
 * `copy`, `move`, `rmdir` da bi bo — xoa/chep file la viec cua remove_file/move_file,
 * khong can mo them mot duong nua.
 */
const WIN_BUILTINS = new Set(["echo", "dir", "type", "cls"])

/**
 * Ky tu ma cmd.exe dien giai TRUOC khi chuong trinh nhin thay tham so.
 *
 * Day la cho nguy hiem nhat cua duong vong qua cmd.exe: Node trich dan tham so
 * theo quy tac cua CommandLineToArgvW, con cmd.exe lai boc lai mot lop rieng.
 * Hai quy tac nay khac nhau, nen mot tham so chua `&` van co the tach thanh lenh
 * thu hai du `shell: false`. Hien tai tham so deu den tu repos.json (tin duoc),
 * nhung chi can mot tool tuong lai truyen text cua nguoi dung vao `npm run` la
 * thanh lo hong. Chan thang tay o day cho khoi quen.
 */
const CMD_META = /[&|<>^"%\r\n]/

/**
 * Bien moi truong Windows bat buoc phai truyen xuong.
 *
 * Danh sach env truoc day chi co PATH/HOME — dung tren Linux, sai tren Windows:
 * thieu SystemRoot thi winsock khong khoi tao duoc (moi thu cham mang deu chet),
 * thieu USERPROFILE thi git khong tim thay .gitconfig toan cuc, tuc khong co
 * credential helper, tuc `git push` treo hoac fail. Smoke test khong bat duoc
 * loi nay vi no chi commit trong repo tam da co san identity o .git/config.
 */
const WIN_ENV_PASSTHROUGH = [
	"SystemRoot",
	"windir",
	"ComSpec",
	"PATHEXT",
	"SystemDrive",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
]

const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL|AUTH)/i

function childEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		LANG: "C",
		DOTNET_CLI_TELEMETRY_OPTOUT: "1",
		DOTNET_NOLOGO: "1",
		GIT_TERMINAL_PROMPT: "0", // khong treo cho nhap credential
		...(extraEnv ?? {}),
	}
	if (process.env.HOME) env.HOME = process.env.HOME

	if (process.platform === "win32") {
		for (const k of WIN_ENV_PASSTHROUGH) {
			const v = process.env[k]
			if (v !== undefined && env[k] === undefined) env[k] = v
		}
		if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE
	}

	// Always strip server MCP_TOKEN from spawned child environments
	delete env.MCP_TOKEN

	return env
}

export function buildTerminalEnv(extraEnv?: Record<string, string>, inheritSecrets = false): Record<string, string> {
	const base = childEnv(extraEnv)
	const out: Record<string, string> = {}

	for (const [k, v] of Object.entries(base)) {
		if (v === undefined) continue
		if (!inheritSecrets && SECRET_KEY_PATTERN.test(k)) {
			continue
		}
		out[k] = v
	}
	delete out.MCP_TOKEN
	return out
}

/**
 * SIGKILL tren Windows chi giet dung tien trinh duoc spawn. Neu do la cmd.exe thi
 * npm/node/dotnet ben duoi song tiep — timeout coi nhu vo nghia. taskkill /T giet
 * ca cay.
 *
 * Export ra ngoai vi khong chi timeout can den no: luc tat server cung phai giet
 * cac job dang chay, khong thi `dotnet build` thanh tien trinh mo coi.
 */
export function killTree(p: ChildProcess): void {
	if (process.platform === "win32" && p.pid) {
		try {
			const k = spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], {
				stdio: "ignore",
			})
			k.on("error", () => p.kill("SIGKILL"))
			return
		} catch {
			// roi xuong duong duoi
		}
	}
	p.kill("SIGKILL")
}

/**
 * Chay argv co dinh, khong qua shell, trong cwd la root cua MOT repo.
 * cwd la tham so bat buoc: multi-repo nen khong con "thu muc mac dinh" nao dung.
 *
 * onSpawn: nhan ChildProcess ngay khi tao, de nguoi goi (jobs.ts) con cach giet
 * no giua duong. Khong co no thi tien trinh chay xong moi biet la ai.
 */
export function run(
	argv: string[],
	opts: { cwd: string; timeoutMs?: number; onSpawn?: (p: ChildProcess) => void; env?: Record<string, string> },
): Promise<ExecResult> {
	const [rawCmd, ...rawArgs] = argv
	if (!rawCmd) throw new Error("argv rong")

	const cwd0 =
		opts.cwd === FULL_ACCESS_ROOT
			? (process.env.FULL_ACCESS_CWD ?? process.cwd())
			: opts.cwd
	if (!existsSync(cwd0)) {
		throw new Error(
			`cwd khong ton tai: "${cwd0}" (repo root khong hop le). ` +
				`Loi spawn ENOENT o day la do cwd, khong phai do thieu "${rawCmd}"`,
		)
	}

	const resolved = resolveCmd(rawCmd)

	// Windows chan spawn truc tiep .cmd/.bat khi shell: false (EINVAL), va builtin
	// thi khong co file de spawn. Ca hai truong hop deu phai di qua cmd.exe.
	const viaCmd =
		process.platform === "win32" &&
		(resolved.endsWith(".cmd") ||
			resolved.endsWith(".bat") ||
			WIN_BUILTINS.has(rawCmd.toLowerCase()))

	if (viaCmd) {
		for (const a of rawArgs) {
			if (CMD_META.test(a))
				throw new Error(
					`tham so "${a}" chua ky tu ma cmd.exe se dien giai (& | < > ^ " %). ` +
						`Tu choi chay "${rawCmd}" de khong bien tham so thanh lenh thu hai`,
				)
		}
	}

	const cmd = viaCmd ? process.env.ComSpec || "cmd.exe" : resolved
	const args = viaCmd ? ["/d", "/s", "/c", rawCmd, ...rawArgs] : rawArgs

	return new Promise((res, rej) => {
		const p = spawn(cmd, args, {
			cwd: cwd0,
			shell: false, // BAT BUOC
			env: childEnv(opts.env),
		})
		opts.onSpawn?.(p)

		let out = ""
		let err = ""
		let timedOut = false
		const t = setTimeout(() => {
			timedOut = true
			killTree(p)
		}, opts.timeoutMs ?? EXEC_TIMEOUT_MS)

		p.stdout.on("data", (d) => {
			if (out.length < MAX_OUTPUT) out += d.toString()
		})
		p.stderr.on("data", (d) => {
			if (err.length < MAX_OUTPUT) err += d.toString()
		})
		p.on("error", (e) => {
			clearTimeout(t)
			rej(e)
		})
		p.on("close", (code) => {
			clearTimeout(t)
			res({
				code,
				stdout: out.slice(0, MAX_OUTPUT),
				stderr: err.slice(0, MAX_OUTPUT),
				timedOut,
			})
		})
	})
}

import { z } from "zod"
import { resolveRepo } from "../repos.js"
import { featureContext } from "./featureContext.js"
import { traceFlow } from "./traceFlow.js"

export const analyzeFeatureSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
	query: z
		.string()
		.min(1)
		.describe("Cau hoi/ten chuc nang (vd: 'luong nang tuong chay the nao'). Neu query chua ten symbol (vd WallUpdater) thi server tu lan luong goi"),
	symbol: z.string().optional().describe("Symbol can trace ro rang — uu tien hon tu doan tu query"),
	glob: z.string().optional().describe("Gioi han loai file, vd: *.cs, *.ts"),
	detail: z.enum(["L0", "L1", "L2"]).optional().describe("Muc doc file, mac dinh L1"),
	depth: z.number().int().min(1).max(2).optional().describe("Do sau trace (mac dinh 1)"),
	max_files: z.number().int().min(1).max(50).optional(),
	max_total_bytes: z.number().int().min(1).optional(),
	refresh: z.boolean().optional().describe("Bo qua cache"),
}

type Args = {
	repo?: string
	query: string
	symbol?: string
	glob?: string
	detail?: "L0" | "L1" | "L2"
	depth?: number
	max_files?: number
	max_total_bytes?: number
	refresh?: boolean
}

/**
 * Doan symbol de trace tu query tu do: lay token dang identifier co chu hoa
 * (PascalCase/camelCase), dai nhat thi thang. Query thuan van xuong khong co ten
 * symbol (vd tieng Viet khong dau) thi bo qua trace thay vi doan sai.
 */
function guessSymbol(query: string): string | null {
	const tokens = query.match(/[A-Za-z_]\w{2,}/g) ?? []
	const cased = tokens.filter((t) => /[A-Z]/.test(t))
	if (cased.length === 0) return null
	return cased.sort((a, b) => b.length - a.length)[0]
}

export async function analyzeFeature(a: Args) {
	const t0 = Date.now()
	const repo = resolveRepo(a.repo)
	const sym = a.symbol?.trim() || guessSymbol(a.query)

	// Hai nhanh doc lap: tim file lien quan + lan luong goi. Chay song song.
	const [context, trace] = await Promise.all([
		featureContext({
			repo: repo.name,
			query: a.query,
			glob: a.glob,
			detail: a.detail ?? "L1",
			max_files: a.max_files,
			max_total_bytes: a.max_total_bytes,
			refresh: a.refresh,
		}),
		sym
			? traceFlow({
					repo: repo.name,
					symbol: sym,
					glob: a.glob,
					depth: a.depth ?? 1,
					refresh: a.refresh,
				})
			: Promise.resolve(null),
	])

	// Query tu do (van xuong) thuong khong match literal — tim lai bang ten symbol.
	const finalContext =
		context.matched_files === 0 && sym
			? await featureContext({
					repo: repo.name,
					query: sym,
					glob: a.glob,
					detail: a.detail ?? "L1",
					max_files: a.max_files,
					max_total_bytes: a.max_total_bytes,
					refresh: a.refresh,
				})
			: context

	return {
		repo: repo.name,
		query: a.query,
		symbol_traced: trace?.symbol ?? null,
		context: finalContext,
		trace,
		total_bytes: finalContext.total_bytes + (trace ? JSON.stringify(trace).length : 0),
		cache_hit: finalContext.cache_hit && (trace?.cache_hit ?? true),
		elapsed_ms: Date.now() - t0,
		...(!sym
			? {
					note: "Query khong chua ten symbol ro rang nen bo qua trace_flow. Truyen tham so symbol (vd: WallUpdater) de lan luong goi.",
				}
			: {}),
	}
}

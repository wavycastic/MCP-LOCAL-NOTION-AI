import { z } from "zod"
import { resolveRepo } from "../repos.js"
import { forceRebuildSymbolIndex } from "../symbolIndex.js"

export const reindexSchema = {
	repo: z.string().optional().describe("Ten repo (xem list_repos)"),
}

/*
 * Ep build lai tree-sitter symbol index cua repo, bo qua moi cache.
 * Index thuong tu invalidate theo repoStamp (HEAD + git status), nen tool nay
 * chi can khi muon lam tuoi chu dong. Truoc day chay `npx gitnexus analyze` —
 * da bo GitNexus, index gio nam trong process.
 */
export async function reindex(a: { repo?: string }) {
	const repo = resolveRepo(a.repo)
	const t0 = Date.now()
	const idx = await forceRebuildSymbolIndex(repo.root)
	return {
		repo: repo.name,
		symbol_index: idx !== null,
		files: idx?.fileCount ?? 0,
		symbols: idx?.defCount ?? 0,
		elapsed_ms: Date.now() - t0,
		...(idx ? {} : { note: "repo khong co file thuoc ngon ngu ho tro — trace_flow dung heuristic ripgrep" }),
	}
}

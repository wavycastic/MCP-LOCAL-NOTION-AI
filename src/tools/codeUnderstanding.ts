import { z } from "zod";
import { readTextSnapshot } from "../files/text.js";
import { runFlowLens } from "../flowlens.js";
import { resolveRepo } from "../repos.js";
import { safeResolve } from "../security/paths.js";

export const repoOverviewSchema = { repo: z.string().optional().describe("Ten repo (xem list_repos)") };
export const inspectCodebaseSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  query: z.string().min(1).describe("Cau hoi tu nhien ve codebase"),
  include_tests: z.boolean().optional().describe("Bao gom test lien quan; mac dinh true"),
  limit: z.number().int().min(1).max(50).optional().describe("So candidate toi da"),
};
export const indexFilesSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  changed_files: z.array(z.string()).max(200).optional().describe("File source vua thay doi; bo trong de index day du"),
};
export const readContextSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  ranges: z.array(z.object({ file: z.string(), start_line: z.number().int().min(1), end_line: z.number().int().min(1) })).min(1).max(100),
  max_bytes: z.number().int().min(1).optional().describe("Tong byte toi da; mac dinh 256000"),
  max_files: z.number().int().min(1).max(50).optional().describe("So range da gop toi da; mac dinh 20"),
};

const symbolBaseSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  symbol: z.string().min(1).describe("Ten symbol"),
  file: z.string().optional().describe("File qualifier de xu ly trung ten"),
  limit: z.number().int().min(1).max(500).optional(),
};
export const findSymbolSchema = symbolBaseSchema;
export const findReferencesSchema = symbolBaseSchema;
export const explainSymbolSchema = { ...symbolBaseSchema, rename_to: z.string().min(1).optional(), include_diagnostics: z.boolean().optional(), include_code_actions: z.boolean().optional() };
export const traceFlowSchema = { repo: z.string().optional().describe("Ten repo (xem list_repos)"), from: z.string().min(1), to: z.string().min(1).optional(), max_depth: z.number().int().min(1).max(20).optional(), limit: z.number().int().min(1).max(100).optional() };
export const whatBreaksSchema = { repo: z.string().optional().describe("Ten repo (xem list_repos)"), target: z.string().min(1), direction: z.enum(["upstream", "downstream", "bidirectional"]).optional(), max_depth: z.number().int().min(0).max(20).optional(), include_tests: z.boolean().optional() };

export async function repoOverview(a: { repo?: string }) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "repo-overview")) };
}

export async function inspectCodebase(a: { repo?: string; query: string; include_tests?: boolean; limit?: number }) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "inspect-codebase", { query: a.query, includeTests: a.include_tests ?? true, limit: a.limit })) };
}

export async function indexFiles(a: { repo?: string; changed_files?: string[] }) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "index-files", { changedFiles: a.changed_files })) };
}

export async function findSymbol(a: { repo?: string; symbol: string; file?: string; limit?: number }) { const repo = resolveRepo(a.repo); return { repo: repo.name, ...(await runFlowLens(repo, "find-symbol", { symbol: a.symbol, file: a.file, limit: a.limit })) }; }
export async function findReferences(a: { repo?: string; symbol: string; file?: string; limit?: number }) { const repo = resolveRepo(a.repo); return { repo: repo.name, ...(await runFlowLens(repo, "find-references", { symbol: a.symbol, file: a.file, limit: a.limit })) }; }
export async function explainSymbol(a: { repo?: string; symbol: string; file?: string; limit?: number; rename_to?: string; include_diagnostics?: boolean; include_code_actions?: boolean }) { const repo = resolveRepo(a.repo); return { repo: repo.name, ...(await runFlowLens(repo, "explain-symbol-lsp", { symbol: a.symbol, file: a.file, limit: a.limit, renameTo: a.rename_to, includeDiagnostics: a.include_diagnostics, includeCodeActions: a.include_code_actions })) }; }
export async function traceFlow(a: { repo?: string; from: string; to?: string; max_depth?: number; limit?: number }) { const repo = resolveRepo(a.repo); return { repo: repo.name, ...(await runFlowLens(repo, "trace-flow", { from: a.from, to: a.to, maxDepth: a.max_depth, limit: a.limit })) }; }
export async function whatBreaks(a: { repo?: string; target: string; direction?: "upstream" | "downstream" | "bidirectional"; max_depth?: number; include_tests?: boolean }) { const repo = resolveRepo(a.repo); return { repo: repo.name, ...(await runFlowLens(repo, "what-breaks", { target: a.target, direction: a.direction, maxDepth: a.max_depth, includeTests: a.include_tests })) }; }

export async function readContext(a: { repo?: string; ranges: Array<{ file: string; start_line: number; end_line: number }>; max_bytes?: number; max_files?: number }) {
  const repo = resolveRepo(a.repo);
  const maxBytes = a.max_bytes ?? 256_000;
  const sorted = [...a.ranges].sort((left, right) => left.file.localeCompare(right.file) || left.start_line - right.start_line);
  const merged: typeof sorted = [];
  for (const range of sorted) {
    if (range.end_line < range.start_line) throw new Error(`end_line phai >= start_line cho ${range.file}`);
    const last = merged.at(-1);
    if (last && last.file === range.file && range.start_line <= last.end_line + 1) last.end_line = Math.max(last.end_line, range.end_line);
    else merged.push({ ...range });
  }
  const selected = merged.slice(0, a.max_files ?? 20);
  const output = [];
  const omitted = merged.slice(selected.length);
  let bytes = 0;
  for (const range of selected) {
    const snap = readTextSnapshot(safeResolve(repo.root, range.file));
    const lines = snap.text.split(/\r?\n/);
    const startLine = Math.max(1, range.start_line);
    const endLine = Math.min(lines.length, Math.max(startLine, range.end_line));
    const text = lines.slice(startLine - 1, endLine).join("\n");
    const size = Buffer.byteLength(text, "utf8");
    if (bytes + size > maxBytes) { omitted.push(range); continue; }
    bytes += size;
    output.push({ file: range.file, start_line: startLine, end_line: endLine, text, sha256: snap.sha256, bytes: size });
  }
  return { repo: repo.name, ranges: output, omitted, bytes, max_bytes: maxBytes, truncated: omitted.length > 0 };
}

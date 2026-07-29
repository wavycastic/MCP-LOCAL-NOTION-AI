import { z } from "zod";
import { readTextSnapshot } from "../files/text.js";
import { runFlowLens } from "../flowlens.js";
import { resolveRepo } from "../repos.js";
import { safeResolve } from "../security/paths.js";

const agentUxSchema = {
  output_mode: z.enum(["minimal", "summary", "full"]).optional().describe("Muc chi tiet output; mac dinh summary"),
  budget: z.enum(["small", "medium", "large", "custom"]).optional().describe("Context budget; mac dinh medium"),
  max_context_tokens: z.number().int().positive().optional(), max_files: z.number().int().positive().optional(), max_symbols: z.number().int().positive().optional(), max_graph_depth: z.number().int().positive().optional(), max_output_bytes: z.number().int().positive().optional(),
};
export const repoOverviewSchema = { repo: z.string().optional().describe("Ten repo (xem list_repos)"), ...agentUxSchema };
export const inspectCodebaseSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  query: z.string().min(1).describe("Cau hoi tu nhien ve codebase"),
  include_tests: z.boolean().optional().describe("Bao gom test lien quan; mac dinh true"),
  semantic: z.boolean().optional().describe("Dung local embedding candidates; mac dinh true"),
  limit: z.number().int().min(1).max(50).optional().describe("So candidate toi da"),
  ...agentUxSchema,
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

type AgentUxArgs = { output_mode?: "minimal" | "summary" | "full"; budget?: "small" | "medium" | "large" | "custom"; max_context_tokens?: number; max_files?: number; max_symbols?: number; max_graph_depth?: number; max_output_bytes?: number };
function agentUx(a: AgentUxArgs) { return { outputMode: a.output_mode, budget: a.budget, maxContextTokens: a.max_context_tokens, maxFiles: a.max_files, maxSymbols: a.max_symbols, maxGraphDepth: a.max_graph_depth, maxOutputBytes: a.max_output_bytes }; }
export async function repoOverview(a: { repo?: string } & AgentUxArgs) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "repo-overview", agentUx(a))) };
}

export async function inspectCodebase(a: { repo?: string; query: string; include_tests?: boolean; semantic?: boolean; limit?: number } & AgentUxArgs) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "inspect-codebase", { query: a.query, includeTests: a.include_tests ?? true, semantic: a.semantic ?? true, limit: a.limit, ...agentUx(a) })) };
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

const changeAgentUxSchema = {
  budget: z.enum(["small", "medium", "large", "custom"]).optional().describe("Context budget; mac dinh medium"),
  max_context_tokens: z.number().int().positive().optional(),
  max_files: z.number().int().positive().optional(),
  max_symbols: z.number().int().positive().optional(),
  max_paths: z.number().int().positive().optional(),
  max_graph_depth: z.number().int().positive().optional(),
  include_tests: z.boolean().optional().describe("Bao gom test context; mac dinh true"),
  output_version: z.number().int().min(1).optional().describe("Envelope output version"),
};

export const searchCodeSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  query: z.string().min(1).describe("Cau hoi / keyword tim trong codebase"),
  channels: z.string().optional().describe("Kenh tim kiem, vd: symbol,graph,fts"),
  expand_graph: z.boolean().optional().describe("Mo rong ket qua qua graph; mac dinh false"),
  limit: z.number().int().min(1).max(100).optional(),
  budget: z.enum(["small", "medium", "large", "custom"]).optional(),
  max_context_tokens: z.number().int().positive().optional(),
  include_tests: z.boolean().optional(),
  output_version: z.number().int().min(1).optional(),
};

export const prepareChangeSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  intent: z.string().optional().describe("Mo ta thay doi muon thuc hien"),
  file: z.string().optional().describe("File goi y lam diem bat dau"),
  symbol: z.string().optional().describe("Symbol goi y lam diem bat dau"),
  ...changeAgentUxSchema,
};

export const canEditSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  file: z.string().min(1).describe("File muon chinh sua (bat buoc)"),
  intent: z.string().optional().describe("Mo ta thay doi muon thuc hien"),
  symbol: z.string().optional().describe("Symbol muon chinh sua"),
  plan_path: z.string().optional().describe("Duong dan JSON plan tu prepare_change"),
  planned_change: z.string().optional().describe("Mo ta thay doi da lap ke hoach"),
  ...changeAgentUxSchema,
};

export const verifyChangeSchema = {
  repo: z.string().optional().describe("Ten repo (xem list_repos)"),
  files: z.array(z.string()).optional().describe("File da thay doi can verify"),
  targets: z.array(z.string()).optional().describe("Symbol/route muc tieu"),
  plan_path: z.string().optional().describe("Duong dan JSON plan tu prepare_change"),
  diff_scope: z.string().optional().describe("Git diff scope: unstaged, staged, all, compare, explicit"),
  budget: z.enum(["small", "medium", "large", "custom"]).optional(),
  max_context_tokens: z.number().int().positive().optional(),
  include_tests: z.boolean().optional(),
  output_version: z.number().int().min(1).optional().describe("8 cho canonical verify-change.v1 envelope"),
};

export async function searchCode(a: { repo?: string; query: string; channels?: string; expand_graph?: boolean; limit?: number; budget?: "small" | "medium" | "large" | "custom"; max_context_tokens?: number; include_tests?: boolean; output_version?: number }) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "search-code", { intent: a.query, channels: a.channels, expandGraph: a.expand_graph, limit: a.limit, budget: a.budget, maxContextTokens: a.max_context_tokens, includeTests: a.include_tests, outputVersion: a.output_version })) };
}

export async function prepareChange(a: { repo?: string; intent?: string; file?: string; symbol?: string; budget?: "small" | "medium" | "large" | "custom"; max_context_tokens?: number; max_files?: number; max_symbols?: number; max_paths?: number; max_graph_depth?: number; include_tests?: boolean; output_version?: number }) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "prepare-change", { intent: a.intent, file: a.file, symbol: a.symbol, budget: a.budget, maxContextTokens: a.max_context_tokens, maxFiles: a.max_files, maxSymbols: a.max_symbols, maxPaths: a.max_paths, maxGraphDepth: a.max_graph_depth, includeTests: a.include_tests, outputVersion: a.output_version })) };
}

export async function canEdit(a: { repo?: string; file: string; intent?: string; symbol?: string; plan_path?: string; planned_change?: string; budget?: "small" | "medium" | "large" | "custom"; max_context_tokens?: number; max_files?: number; max_symbols?: number; max_paths?: number; max_graph_depth?: number; include_tests?: boolean }) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "can-edit", { file: a.file, intent: a.intent, symbol: a.symbol, planPath: a.plan_path, plannedChange: a.planned_change, budget: a.budget, maxContextTokens: a.max_context_tokens, maxFiles: a.max_files, maxSymbols: a.max_symbols, maxPaths: a.max_paths, maxGraphDepth: a.max_graph_depth, includeTests: a.include_tests })) };
}

export async function verifyChange(a: { repo?: string; files?: string[]; targets?: string[]; plan_path?: string; diff_scope?: string; budget?: "small" | "medium" | "large" | "custom"; max_context_tokens?: number; include_tests?: boolean; output_version?: number }) {
  const repo = resolveRepo(a.repo);
  return { repo: repo.name, ...(await runFlowLens(repo, "verify-change", { files: a.files, targets: a.targets, planPath: a.plan_path, diffScope: a.diff_scope, budget: a.budget, maxContextTokens: a.max_context_tokens, includeTests: a.include_tests, outputVersion: a.output_version })) };
}

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

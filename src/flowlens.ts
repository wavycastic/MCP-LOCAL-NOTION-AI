import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.js";
import type { Repo } from "./repos.js";
import { clearQueue, enqueueFiles, peekQueue, queueDepth } from "./pendingQueue.js";

/** Replay pending queues for all repos on server startup. Fire-and-forget. */
export async function replayPendingQueues(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    const pending = peekQueue(repo.root);
    if (pending.length === 0) continue;
    console.log(`[pendingQueue] replaying ${pending.length} pending files for "${repo.name}"`);
    try {
      const result = await runFlowLens(repo, "index-files", { changedFiles: pending });
      if (result && typeof result === "object" && "generation" in result && result.generation != null) {
        clearQueue(repo.root);
        console.log(`[pendingQueue] replay done for "${repo.name}" (generation=${result.generation})`);
      } else {
        console.warn(`[pendingQueue] replay incomplete for "${repo.name}" — FlowLens did not confirm generation, queue kept`);
      }
    } catch (e) {
      console.warn(`[pendingQueue] replay failed for "${repo.name}":`, e);
    }
  }
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

type FlowLensCommand = "index-files" | "repo-overview" | "inspect-codebase" | "find-symbol" | "find-references" | "explain-symbol-lsp" | "trace-flow" | "what-breaks" | "search-code" | "prepare-change" | "can-edit" | "verify-change";

export async function runFlowLens(repo: Repo, command: FlowLensCommand, options: { changedFiles?: string[]; query?: string; symbol?: string; target?: string; file?: string; from?: string; to?: string; direction?: "upstream" | "downstream" | "bidirectional"; renameTo?: string; includeTests?: boolean; semantic?: boolean; includeDiagnostics?: boolean; includeCodeActions?: boolean; maxDepth?: number; limit?: number; outputMode?: "minimal" | "summary" | "full"; budget?: "small" | "medium" | "large" | "custom"; maxContextTokens?: number; maxFiles?: number; maxSymbols?: number; maxGraphDepth?: number; maxOutputBytes?: number; maxPaths?: number; intent?: string; channels?: string; expandGraph?: boolean; planPath?: string; plannedChange?: string; files?: string[]; targets?: string[]; diffScope?: string; outputVersion?: number } = {}) {
  const cli = resolveFlowLensCli();
  if (!cli) return { available: false, stale: true, changedFilesPending: options.changedFiles?.length ?? 0, error: "FlowLens CLI not found. Set FLOWLENS_CLI or build the sibling flowlens repository." };
  const argv = [process.execPath, cli, command];
  if (command === "index-files") {
    argv.push(repo.root);
    const files = (options.changedFiles ?? []).filter(isSourceFile);
    if (options.changedFiles && files.length === 0) return { available: true, skipped: true, generation: null, stale: false, changedFilesPending: 0 };
    if (files.length > 0) argv.push("--changed-file", ...files);
  } else {
    if (command === "inspect-codebase") argv.push(options.query ?? "");
    if (command === "search-code") argv.push(options.intent ?? "");
    if (command === "find-symbol" || command === "find-references" || command === "explain-symbol-lsp") argv.push(options.symbol ?? "");
    if (command === "trace-flow") argv.push(options.from ?? "");
    if (command === "what-breaks") argv.push(options.target ?? "");
    argv.push("--project", repo.root);
    if (command === "inspect-codebase" && options.includeTests) argv.push("--include-tests");
    if (command === "inspect-codebase" && options.semantic === false) argv.push("--no-semantic");
    if (command === "inspect-codebase" && options.limit) argv.push("--limit", String(options.limit));
    if ((command === "find-symbol" || command === "find-references") && options.limit) argv.push("--limit", String(options.limit));
    if ((command === "find-symbol" || command === "find-references" || command === "explain-symbol-lsp") && options.file) argv.push("--file", options.file);
    if (command === "explain-symbol-lsp" && options.renameTo) argv.push("--rename-to", options.renameTo);
    if (command === "explain-symbol-lsp" && options.includeDiagnostics === false) argv.push("--no-diagnostics");
    if (command === "explain-symbol-lsp" && options.includeCodeActions === false) argv.push("--no-code-actions");
    if (command === "trace-flow" && options.to) argv.push("--to", options.to);
    if (command === "trace-flow" && options.maxDepth) argv.push("--max-depth", String(options.maxDepth));
    if (command === "trace-flow" && options.limit) argv.push("--limit", String(options.limit));
    if (command === "what-breaks" && options.direction) argv.push("--direction", options.direction);
    if (command === "what-breaks" && options.maxDepth) argv.push("--max-depth", String(options.maxDepth));
    if (command === "what-breaks" && options.includeTests) argv.push("--include-tests");
    if ((command === "repo-overview" || command === "inspect-codebase") && options.outputMode) argv.push("--output-mode", options.outputMode);
    const budgetCommands = new Set(["repo-overview", "inspect-codebase", "search-code", "prepare-change", "can-edit", "verify-change", "what-breaks"] as FlowLensCommand[]);
    if (budgetCommands.has(command) && options.budget) argv.push("--budget", options.budget);
    if (budgetCommands.has(command) && options.maxContextTokens !== undefined) argv.push("--max-context-tokens", String(options.maxContextTokens));
    const uxLimitCommands = new Set(["repo-overview", "inspect-codebase", "prepare-change", "can-edit"] as FlowLensCommand[]);
    if (uxLimitCommands.has(command) && options.maxFiles !== undefined) argv.push("--max-files", String(options.maxFiles));
    if (uxLimitCommands.has(command) && options.maxSymbols !== undefined) argv.push("--max-symbols", String(options.maxSymbols));
    if (uxLimitCommands.has(command) && options.maxGraphDepth !== undefined) argv.push("--max-graph-depth", String(options.maxGraphDepth));
    if (command === "repo-overview" && options.maxOutputBytes !== undefined) argv.push("--max-output-bytes", String(options.maxOutputBytes));
    if ((command === "prepare-change" || command === "can-edit") && options.maxPaths !== undefined) argv.push("--max-paths", String(options.maxPaths));
    // search-code
    if (command === "search-code" && options.channels) argv.push("--channels", options.channels);
    if (command === "search-code" && options.expandGraph) argv.push("--expand-graph");
    if (command === "search-code" && options.limit) argv.push("--limit", String(options.limit));
    // prepare-change / can-edit positional intent & file
    if ((command === "prepare-change" || command === "can-edit") && options.includeTests) argv.push("--include-tests");
    if ((command === "prepare-change" || command === "can-edit") && options.symbol) argv.push("--symbol", options.symbol);
    // can-edit specific
    if (command === "can-edit" && options.file) argv.push("--file", options.file);
    if (command === "can-edit" && options.planPath) argv.push("--plan", options.planPath);
    if (command === "can-edit" && options.plannedChange) argv.push("--planned-change", options.plannedChange);
    // verify-change
    if (command === "verify-change" && options.files && options.files.length > 0) argv.push("--files", ...options.files);
    if (command === "verify-change" && options.targets && options.targets.length > 0) argv.push("--targets", ...options.targets);
    if (command === "verify-change" && options.planPath) argv.push("--plan", options.planPath);
    if (command === "verify-change" && options.diffScope) argv.push("--diff-scope", options.diffScope);
    if (command === "verify-change" && options.includeTests) argv.push("--include-tests");
    // outputVersion for prepare-change, can-edit (no), verify-change
    if ((command === "prepare-change" || command === "verify-change") && options.outputVersion !== undefined) argv.push("--output-version", String(options.outputVersion));
    // prepare-change file hint
    if (command === "prepare-change" && options.file) argv.push("--file", options.file);
    // intent positional (MUST be last before --json for prepare-change, can-edit)
    if ((command === "prepare-change" || command === "can-edit") && options.intent) argv.push(options.intent);
  }
  argv.push("--json");
  const result = await run(argv, { cwd: repo.root, timeoutMs: 120_000, maxOutputBytes: 2_000_000 });
  if (result.code !== 0) return { available: true, stale: true, changedFilesPending: options.changedFiles?.length ?? 0, error: result.stderr.trim() || result.stdout.trim() || `FlowLens exited with code ${result.code}` };
  try { return JSON.parse(result.stdout); }
  catch { return { available: true, stale: true, changedFilesPending: options.changedFiles?.length ?? 0, error: "FlowLens returned invalid JSON.", output: result.stdout.slice(-4_000) }; }
}

export async function syncFlowLensAfterTool(repo: Repo, tool: string, output: unknown) {
  if (/^(0|false|off|no)$/i.test(process.env.FLOWLENS_AUTO_INDEX ?? "true")) return undefined;
  const changedFiles = changedPaths(tool, output);
  if (changedFiles.length === 0) return undefined;

  // Ghi vào queue bền vững TRƯỚC khi gọi FlowLens.
  // Nếu FlowLens timeout/crash, files vẫn nằm trong queue và sẽ được replay.
  enqueueFiles(repo.root, changedFiles);

  // Cũng merge bất kỳ file nào đang pending từ lần trước (deduplicated bởi peekQueue).
  const allPending = peekQueue(repo.root);
  const result = await runFlowLens(repo, "index-files", { changedFiles: allPending });

  // Chỉ xoá queue khi FlowLens xác nhận generation mới thành công.
  if (result && typeof result === "object" && "generation" in result && result.generation != null) {
    clearQueue(repo.root);
  }

  // Đính kèm changedFilesPending vào kết quả để agent biết trạng thái queue.
  const pending = queueDepth(repo.root);
  return { ...result, changedFilesPending: pending };
}

function changedPaths(tool: string, output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const value = output as Record<string, unknown>;
  if ((tool === "edit_file" || tool === "multi_edit_file") && value.changed === false) return [];
  if (tool === "apply_patch" && value.dry_run === true) return [];
  if (tool === "apply_patch" && Array.isArray(value.changes)) return [...new Set(value.changes.flatMap((change) => {
    if (!change || typeof change !== "object") return [];
    const item = change as Record<string, unknown>;
    return [item.from, item.to, item.path].filter((path): path is string => typeof path === "string");
  }))];
  if (tool === "move_file") return [value.from, value.to].filter((path): path is string => typeof path === "string");
  if (tool === "git_restore" && Array.isArray(value.restored)) return value.restored.filter((path): path is string => typeof path === "string");
  return typeof value.path === "string" ? [value.path] : [];
}

function resolveFlowLensCli(): string | undefined {
  const configured = process.env.FLOWLENS_CLI;
  if (configured && existsSync(configured)) return resolve(configured);
  const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    resolve(appRoot, "..", "flowlens", "dist", "cli", "index.js"),
    resolve(process.cwd(), "..", "flowlens", "dist", "cli", "index.js"),
  ];
  return candidates.find(existsSync);
}

function isSourceFile(file: string) {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

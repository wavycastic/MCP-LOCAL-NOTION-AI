import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.js";
import type { Repo } from "./repos.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

type FlowLensCommand = "index-files" | "repo-overview" | "inspect-codebase" | "find-symbol" | "find-references" | "explain-symbol-lsp" | "trace-flow" | "what-breaks";

export async function runFlowLens(repo: Repo, command: FlowLensCommand, options: { changedFiles?: string[]; query?: string; symbol?: string; target?: string; file?: string; from?: string; to?: string; direction?: "upstream" | "downstream" | "bidirectional"; renameTo?: string; includeTests?: boolean; semantic?: boolean; includeDiagnostics?: boolean; includeCodeActions?: boolean; maxDepth?: number; limit?: number } = {}) {
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
  return runFlowLens(repo, "index-files", { changedFiles });
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

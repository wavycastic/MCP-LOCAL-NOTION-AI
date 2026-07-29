import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.js";
import type { Repo } from "./repos.js";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type FlowLensErrorCode =
  | "cli_missing"
  | "timeout"
  | "parse_error"
  | "crash"
  | "output_truncated"
  | "validation_error"
  | "version_mismatch";

const MIN_SUPPORTED_VERSION = "0.5.0";
const CURRENT_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Probe / handshake
// ---------------------------------------------------------------------------

export type FlowLensProbeResult =
  | { available: true; version: string; protocolVersion: number; capabilities: string[]; cliPath: string }
  | { available: false; errorCode: FlowLensErrorCode; error: string };

/** Cached per CLI path */
const probeCache = new Map<string, FlowLensProbeResult>();

/** Detect capabilities from flowlens CLI (cached per process lifetime). */
export async function probeFlowLens(): Promise<FlowLensProbeResult> {
  const cli = resolveFlowLensCli();
  if (!cli) {
    return { available: false, errorCode: "cli_missing", error: "FlowLens CLI not found. Set FLOWLENS_CLI or build the sibling flowlens repository." };
  }
  const cached = probeCache.get(cli);
  if (cached) return cached;

  const version = await detectFlowLensVersion(cli);
  if (!version) {
    const result: FlowLensProbeResult = { available: false, errorCode: "crash", error: `FlowLens CLI found at ${cli} but could not determine version.` };
    probeCache.set(cli, result);
    return result;
  }

  const capabilities = inferCapabilities(version);
  const result: FlowLensProbeResult = {
    available: true,
    version,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    capabilities,
    cliPath: cli,
  };
  probeCache.set(cli, result);
  return result;
}

async function detectFlowLensVersion(cli: string): Promise<string | undefined> {
  // Try reading package.json adjacent to the CLI first (fast, no spawn)
  try {
    const pkgPath = resolve(dirname(cli), "..", "..", "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    }
  } catch { /* fallthrough */ }
  // Fallback: spawn `node cli.js --version` and parse output
  try {
    const result = await run([process.execPath, cli, "--version"], { cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 4096 });
    const raw = (result.stdout + result.stderr).trim();
    const match = raw.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : undefined;
  } catch { return undefined; }
}

function inferCapabilities(version: string): string[] {
  const caps: string[] = ["code-search", "index-files", "repo-overview", "inspect-codebase"];
  const [major, minor] = version.split(".").map(Number);
  if ((major ?? 0) >= 1 || ((major ?? 0) === 0 && (minor ?? 0) >= 6)) {
    caps.push("output-modes", "multidimensional-budgets", "semantic-search");
  }
  if ((major ?? 0) >= 1 || ((major ?? 0) === 0 && (minor ?? 0) >= 7)) {
    caps.push("search-code", "prepare-change", "can-edit", "verify-change");
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Per-command timeout (ms)
// ---------------------------------------------------------------------------

const COMMAND_TIMEOUT_MS: Partial<Record<FlowLensCommand, number>> = {
  "index-files": 120_000,
  "repo-overview": 90_000,
  "inspect-codebase": 90_000,
};
const DEFAULT_INTELLIGENCE_TIMEOUT_MS = 60_000;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

type FlowLensCommand = "index-files" | "repo-overview" | "inspect-codebase" | "find-symbol" | "find-references" | "explain-symbol-lsp" | "trace-flow" | "what-breaks";

export async function runFlowLens(repo: Repo, command: FlowLensCommand, options: { changedFiles?: string[]; query?: string; symbol?: string; target?: string; file?: string; from?: string; to?: string; direction?: "upstream" | "downstream" | "bidirectional"; renameTo?: string; includeTests?: boolean; semantic?: boolean; includeDiagnostics?: boolean; includeCodeActions?: boolean; maxDepth?: number; limit?: number; outputMode?: "minimal" | "summary" | "full"; budget?: "small" | "medium" | "large" | "custom"; maxContextTokens?: number; maxFiles?: number; maxSymbols?: number; maxGraphDepth?: number; maxOutputBytes?: number } = {}) {
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
    if ((command === "repo-overview" || command === "inspect-codebase") && options.outputMode) argv.push("--output-mode", options.outputMode);
    if ((command === "repo-overview" || command === "inspect-codebase") && options.budget) argv.push("--budget", options.budget);
    for (const [flag, value] of [["--max-context-tokens", options.maxContextTokens], ["--max-files", options.maxFiles], ["--max-symbols", options.maxSymbols], ["--max-graph-depth", options.maxGraphDepth], ["--max-output-bytes", options.maxOutputBytes]] as const) {
      if ((command === "repo-overview" || command === "inspect-codebase") && value !== undefined) argv.push(flag, String(value));
    }
  }
  argv.push("--json");
  const timeoutMs = COMMAND_TIMEOUT_MS[command] ?? DEFAULT_INTELLIGENCE_TIMEOUT_MS;
  const result = await run(argv, { cwd: repo.root, timeoutMs, maxOutputBytes: 2_000_000 });
  const pending = options.changedFiles?.length ?? 0;
  if (result.timedOut) return { available: true, stale: true, changedFilesPending: pending, errorCode: "timeout" as FlowLensErrorCode, error: `FlowLens command '${command}' timed out after ${timeoutMs / 1000}s` };
  if (result.outputTruncated && result.code !== 0) return { available: true, stale: true, changedFilesPending: pending, errorCode: "output_truncated" as FlowLensErrorCode, error: "FlowLens output exceeded 2 MB limit" };
  if (result.code !== 0) {
    const raw = result.stderr.trim() || result.stdout.trim() || `FlowLens exited with code ${result.code}`;
    const isValidation = raw.includes("validation") || raw.includes("invalid") || raw.includes("required") || raw.includes("INVALID_");
    const errorCode: FlowLensErrorCode = isValidation ? "validation_error" : "crash";
    return { available: true, stale: true, changedFilesPending: pending, errorCode, error: raw };
  }
  try { return JSON.parse(result.stdout); }
  catch { return { available: true, stale: true, changedFilesPending: pending, errorCode: "parse_error" as FlowLensErrorCode, error: "FlowLens returned invalid JSON.", output: result.stdout.slice(-4_000) }; }
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

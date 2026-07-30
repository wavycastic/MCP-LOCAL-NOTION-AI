import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function nodeExecPath(): string {
  if ("electron" in process.versions) return "node";
  return process.execPath;
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
    const result = await run([nodeExecPath(), cli, "--version"], { cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 4096 });
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
  "index-files": 180_000,
  "repo-overview": 30_000,
  "inspect-codebase": 45_000,
  "search-code": 30_000,
  "prepare-change": 35_000,
  "can-edit": 30_000,
  "verify-change": 35_000,
};
const DEFAULT_INTELLIGENCE_TIMEOUT_MS = 30_000;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

type FlowLensCommand = "index-files" | "repo-overview" | "inspect-codebase" | "find-symbol" | "find-references" | "explain-symbol-lsp" | "trace-flow" | "what-breaks" | "search-code" | "prepare-change" | "can-edit" | "verify-change";

export async function runFlowLens(repo: Repo, command: FlowLensCommand, options: { changedFiles?: string[]; query?: string; symbol?: string; target?: string; file?: string; from?: string; to?: string; direction?: "upstream" | "downstream" | "bidirectional"; renameTo?: string; includeTests?: boolean; semantic?: boolean; includeDiagnostics?: boolean; includeCodeActions?: boolean; maxDepth?: number; limit?: number; outputMode?: "minimal" | "summary" | "full"; budget?: "small" | "medium" | "large" | "custom"; maxContextTokens?: number; maxFiles?: number; maxSymbols?: number; maxGraphDepth?: number; maxOutputBytes?: number; maxPaths?: number; intent?: string; channels?: string; expandGraph?: boolean; planPath?: string; plannedChange?: string; files?: string[]; targets?: string[]; diffScope?: string; outputVersion?: number; group?: string; crossRepo?: boolean; _isRetry?: boolean } = {}) {
  const cli = resolveFlowLensCli();
  if (!cli) return { available: false, stale: true, changedFilesPending: options.changedFiles?.length ?? 0, error: "FlowLens CLI not found. Set FLOWLENS_CLI or build the sibling flowlens repository." };
  const argv = [nodeExecPath(), cli, command];
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
    if (command === "search-code" && options.semantic !== false) argv.push("--semantic");
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
    // Pass group options only when explicitly requested
    if (options.group) argv.push("--group", options.group);
    if (options.crossRepo) {
      const groupFile = options.group ?? [join(repo.root, "flowlens.group.json"), join(repo.root, ".flowlens", "flowlens.group.json")].find((p) => existsSync(p));
      if (groupFile && !options.group) argv.push("--group", groupFile);
      argv.push("--cross-repo");
    }
  }
  argv.push("--json");
  const timeoutMs = COMMAND_TIMEOUT_MS[command] ?? DEFAULT_INTELLIGENCE_TIMEOUT_MS;
  const result = await run(argv, { cwd: repo.root, timeoutMs, maxOutputBytes: 2_000_000 });
  const pending = options.changedFiles?.length ?? 0;
  if (result.timedOut) return { available: true, stale: true, changedFilesPending: pending, errorCode: "timeout" as FlowLensErrorCode, error: `FlowLens command '${command}' timed out after ${timeoutMs / 1000}s` };
  if (result.outputTruncated && result.code !== 0) return { available: true, stale: true, changedFilesPending: pending, errorCode: "output_truncated" as FlowLensErrorCode, error: "FlowLens output exceeded 2 MB limit" };

  let parsed: any;
  try { parsed = JSON.parse(result.stdout); } catch {}

  const rawOutput = (result.stdout + " " + result.stderr).toLowerCase();
  const isStaleSignal = !options._isRetry && (
    rawOutput.includes("project_index_stale") ||
    rawOutput.includes("stalegraph") ||
    rawOutput.includes("not found in graph index") ||
    rawOutput.includes("run flowlens analyze") ||
    (parsed && typeof parsed === "object" && (
      parsed.stale === true ||
      (Array.isArray(parsed.redFlags) && parsed.redFlags.includes("staleGraph")) ||
      (Array.isArray(parsed.warnings) && parsed.warnings.some((w: string) => String(w).toLowerCase().includes("not found in graph index"))) ||
      parsed.error?.code === "PROJECT_INDEX_STALE" ||
      parsed.error?.code === "MISSING_PROJECT"
    ))
  );

  if (isStaleSignal) {
    // Non-blocking fire-and-forget background re-indexing
    runFlowLens(repo, "index-files", { _isRetry: true }).catch((e) => console.warn(`[auto-heal] background index failed for "${repo.name}":`, e));
  }

  if (result.code !== 0 && !parsed) {
    const raw = result.stderr.trim() || result.stdout.trim() || `FlowLens exited with code ${result.code}`;
    const isValidation = raw.includes("validation") || raw.includes("invalid") || raw.includes("required") || raw.includes("INVALID_");
    const errorCode: FlowLensErrorCode = isValidation ? "validation_error" : "crash";
    return { available: true, stale: true, changedFilesPending: pending, errorCode, error: raw };
  }

  if (parsed) return parsed;
  return { available: true, stale: true, changedFilesPending: pending, errorCode: "parse_error" as FlowLensErrorCode, error: "FlowLens returned invalid JSON.", output: result.stdout.slice(-4_000) };
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

/*
 * Do hieu qua symbol index (tree-sitter) tren chinh repo local-repo-mcp.
 * Chay 2 lan de thay: cold build -> disk cache hit.
 */
process.env.MCP_TOKEN ??= "bench"

const { getSymbolIndex } = await import("../src/symbolIndex.js")
const { traceFlow } = await import("../src/tools/traceFlow.js")

const root = process.cwd()

let t = Date.now()
const idx = await getSymbolIndex(root)
console.log(`symbol index: ${Date.now() - t}ms (files=${idx?.fileCount ?? 0}, defs=${idx?.defCount ?? 0})`)

t = Date.now()
const r1 = await traceFlow({ repo: "local-repo-mcp", symbol: "traceFlow", refresh: true })
console.log(`trace_flow(traceFlow) index warm: ${Date.now() - t}ms, symbol_index=${r1.symbol_index}, defs=${r1.definitions.length}, callers=${r1.callers.length}, callees=${r1.callees.map((c) => `${c.name}:${c.definitions.length}`).join(", ")}`)

t = Date.now()
const r2 = await traceFlow({ repo: "local-repo-mcp", symbol: "featureContext", refresh: true })
console.log(`trace_flow(featureContext) index warm: ${Date.now() - t}ms, symbol_index=${r2.symbol_index}, defs=${r2.definitions.length}, callers=${r2.callers.length}`)

t = Date.now()
const { featureContext } = await import("../src/tools/featureContext.js")
const fc = await featureContext({ repo: "local-repo-mcp", query: "getSymbolIndex", refresh: true })
console.log(`get_feature_context(getSymbolIndex): ${Date.now() - t}ms, symbol_index=${fc.symbol_index}`)
for (const f of fc.files) console.log(`  ${f.path}: outline=${f.outline?.length ?? "-"} -> ${JSON.stringify(f.outline?.slice(0, 3))}`)

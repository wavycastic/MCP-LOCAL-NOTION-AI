/*
 * Benchmark tren codebase that CV-AUT (C#): cold vs warm cho tung tool.
 * Tu tim 1 class C# that trong repo de trace — khong hardcode ten.
 */
process.env.MCP_TOKEN ??= "bench"

const { resolveRepo } = await import("../src/repos.js")
const { getSymbolIndex } = await import("../src/symbolIndex.js")
const { featureContext } = await import("../src/tools/featureContext.js")
const { traceFlow } = await import("../src/tools/traceFlow.js")
const { listDir } = await import("../src/tools/listDir.js")
const { readFile } = await import("../src/tools/readFile.js")
const { ripgrep } = await import("../src/tools/ripgrep.js")

const repo = resolveRepo("CV-AUT")
console.log(`repo: ${repo.name} @ ${repo.root}`)

async function timeIt(name: string, fn: () => Promise<unknown>): Promise<void> {
	const t = Date.now()
	await fn()
	console.log(`${name}: ${Date.now() - t}ms`)
}

// 1. Symbol index tren repo C# that
await timeIt("symbol index cold build", async () => {
	const idx = await getSymbolIndex(repo.root)
	console.log(`   files=${idx?.fileCount ?? 0}, defs=${idx?.defCount ?? 0}`)
})
await timeIt("symbol index warm (mem)", () => getSymbolIndex(repo.root))

// 2. Tim mot class C# that de trace
const rg = await ripgrep({ repo: "CV-AUT", pattern: "\\bclass\\s+[A-Z]\\w+", glob: "*.cs", max_count: 5 })
const firstLine = (rg.results[0]?.matches.split(/\r?\n/)[0] ?? "").trim()
const sym = /class\s+([A-Z]\w+)/.exec(firstLine)?.[1]
const firstPath = firstLine.split(":")[0]?.replace(/\\/g, "/")
console.log(`symbol de trace: ${sym ?? "(khong tim thay)"}, file: ${firstPath ?? "?"}`)

if (sym) {
	await timeIt(`trace_flow(${sym}) cold`, () => traceFlow({ repo: "CV-AUT", symbol: sym, glob: "*.cs", refresh: true }))
	await timeIt(`trace_flow(${sym}) warm cache`, () => traceFlow({ repo: "CV-AUT", symbol: sym, glob: "*.cs" }))
	await timeIt(`get_feature_context(${sym}) cold`, () => featureContext({ repo: "CV-AUT", query: sym, glob: "*.cs", refresh: true }))
	await timeIt(`get_feature_context(${sym}) warm cache`, () => featureContext({ repo: "CV-AUT", query: sym, glob: "*.cs" }))
}

await timeIt("list_dir cold", () => listDir({ repo: "CV-AUT" }))
await timeIt("list_dir warm (ignore-cache)", () => listDir({ repo: "CV-AUT" }))

if (firstPath) {
	await timeIt(`read_file cold`, () => readFile({ repo: "CV-AUT", path: firstPath! }))
	await timeIt(`read_file warm`, () => readFile({ repo: "CV-AUT", path: firstPath! }))
}

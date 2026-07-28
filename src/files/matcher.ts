export type MatchMode =
	| "exact"
	| "eol_normalized"
	| "trailing_whitespace_normalized"

export type TextMatch = {
	start: number
	end: number
	mode: MatchMode
}

function toLf(s: string): string {
	return s.replace(/\r\n/g, "\n")
}

function findExactMatches(source: string, needle: string): TextMatch[] {
	const matches: TextMatch[] = []
	let pos = 0
	while (pos < source.length) {
		const idx = source.indexOf(needle, pos)
		if (idx === -1) break
		matches.push({ start: idx, end: idx + needle.length, mode: "exact" })
		pos = idx + (needle.length || 1)
	}
	return matches
}

function findEolNormalizedMatches(source: string, needle: string): TextMatch[] {
	const normSource = toLf(source)
	const normNeedle = toLf(needle)
	if (normNeedle.length === 0) return []

	// Build mapIndex from normSource -> raw source offsets
	const mapIndex: number[] = new Array(normSource.length + 1)
	let rawPos = 0
	let normPos = 0
	while (normPos < normSource.length) {
		mapIndex[normPos] = rawPos
		if (source[rawPos] === "\r" && source[rawPos + 1] === "\n") {
			rawPos += 2
		} else {
			rawPos += 1
		}
		normPos += 1
	}
	mapIndex[normSource.length] = source.length

	const matches: TextMatch[] = []
	let pos = 0
	while (pos < normSource.length) {
		const idx = normSource.indexOf(normNeedle, pos)
		if (idx === -1) break
		const normEnd = idx + normNeedle.length
		matches.push({
			start: mapIndex[idx]!,
			end: mapIndex[normEnd]!,
			mode: "eol_normalized",
		})
		pos = idx + (normNeedle.length || 1)
	}
	return matches
}

function findTrailingWhitespaceNormalizedMatches(source: string, needle: string): TextMatch[] {
	const normNeedle = toLf(needle)
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")

	if (normNeedle.length === 0) return []

	// Build normSource and mapIndex by scanning lines in source
	let normSource = ""
	const mapIndex: number[] = []

	let rawPos = 0
	const srcLen = source.length

	while (rawPos < srcLen) {
		const rawLineStart = rawPos
		// Find end of line in source
		while (rawPos < srcLen && source[rawPos] !== "\r" && source[rawPos] !== "\n") {
			rawPos++
		}
		const rawContentEnd = rawPos

		let eolLen = 0
		if (rawPos < srcLen && source[rawPos] === "\r" && source[rawPos + 1] === "\n") {
			eolLen = 2
			rawPos += 2
		} else if (rawPos < srcLen && (source[rawPos] === "\n" || source[rawPos] === "\r")) {
			eolLen = 1
			rawPos += 1
		}

		// Trim trailing whitespace from line content
		let trimmedEnd = rawContentEnd
		while (trimmedEnd > rawLineStart && (source[trimmedEnd - 1] === " " || source[trimmedEnd - 1] === "\t")) {
			trimmedEnd--
		}

		// Append trimmed chars to normSource and mapIndex
		for (let k = rawLineStart; k < trimmedEnd; k++) {
			normSource += source[k]
			mapIndex.push(k)
		}

		if (eolLen > 0) {
			normSource += "\n"
			// When matching \n in normSource, mapIndex points to start of trailing spaces (or EOL if no trailing spaces)
			mapIndex.push(trimmedEnd)
		}
	}
	mapIndex.push(srcLen)

	const matches: TextMatch[] = []
	let pos = 0
	while (pos < normSource.length) {
		const idx = normSource.indexOf(normNeedle, pos)
		if (idx === -1) break
		const normEnd = idx + normNeedle.length
		matches.push({
			start: mapIndex[idx]!,
			end: mapIndex[normEnd]!,
			mode: "trailing_whitespace_normalized",
		})
		pos = idx + (normNeedle.length || 1)
	}
	return matches
}

export function findTextMatches(args: {
	source: string
	needle: string
	allowTrailingWhitespace?: boolean
}): TextMatch[] {
	if (!args.needle) {
		throw new Error("old_str non-empty required")
	}

	// Tier 1: Exact match
	const exact = findExactMatches(args.source, args.needle)
	if (exact.length > 0) return exact

	// Tier 2: EOL normalized
	const eolNorm = findEolNormalizedMatches(args.source, args.needle)
	if (eolNorm.length > 0) return eolNorm

	// Tier 3: Trailing whitespace normalized
	if (args.allowTrailingWhitespace !== false) {
		const trNorm = findTrailingWhitespaceNormalizedMatches(args.source, args.needle)
		if (trNorm.length > 0) return trNorm
	}

	return []
}

export function applyReplacements(source: string, matches: TextMatch[], replacement: string): string {
	if (matches.length === 0) return source
	// Sort matches descending by start offset to prevent index drift
	const sorted = [...matches].sort((a, b) => b.start - a.start)
	let result = source
	for (const m of sorted) {
		result = result.slice(0, m.start) + replacement + result.slice(m.end)
	}
	return result
}

export type HunkLine =
	| { type: "context"; text: string }
	| { type: "delete"; text: string }
	| { type: "add"; text: string }

export type Hunk = {
	header?: string
	lines: HunkLine[]
}

export type AddFileOp = {
	kind: "add"
	path: string
	lines: string[]
}

export type DeleteFileOp = {
	kind: "delete"
	path: string
}

export type UpdateFileOp = {
	kind: "update"
	path: string
	moveTo?: string
	hunks: Hunk[]
}

export type FileOperation = AddFileOp | DeleteFileOp | UpdateFileOp

export type ParsedPatch = {
	operations: FileOperation[]
}

export type FileSnapshot = {
	path: string
	existed: boolean
	content?: string
	sha256?: string
	eol?: "lf" | "crlf"
	bom?: boolean
}

export type PlannedChange =
	| {
			type: "add"
			path: string
			newContent: string
			bytesAfter: number
			sha256After: string
	  }
	| {
			type: "update"
			path: string
			oldContent: string
			newContent: string
			bytesBefore: number
			bytesAfter: number
			sha256Before: string
			sha256After: string
			replacements: number
			hunkDiff: string
	  }
	| {
			type: "move"
			from: string
			to: string
			oldContent: string
			newContent: string
			bytesBefore: number
			bytesAfter: number
			sha256Before: string
			sha256After: string
			replacements: number
			hunkDiff: string
	  }
	| {
			type: "delete"
			path: string
			oldContent: string
			bytesBefore: number
			sha256Before: string
	  }

export type PatchPlan = {
	changes: PlannedChange[]
	totalAdditions: number
	totalDeletions: number
}

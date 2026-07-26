import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Toolchain = {
	kind: string
	build?: string[]
	test?: string[]
}

function hasExt(root: string, ext: string): boolean {
	try {
		return readdirSync(root).some((f) => f.endsWith(ext))
	} catch {
		return false
	}
}

function npmScripts(root: string): Set<string> {
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
		return new Set(Object.keys(pkg.scripts ?? {}))
	} catch {
		return new Set()
	}
}

/**
 * Doan build/test cmd tu file dac trung o root repo.
 * Chi tra ve argv co dinh — khong bao gio ghep tu input cua agent.
 * Repo nao can lenh khac thi khai bao tuong minh trong repos.json.
 */
export function detectToolchain(root: string): Toolchain {
	if (hasExt(root, ".sln") || hasExt(root, ".slnx") || hasExt(root, ".csproj")) {
		return {
			kind: "dotnet",
			build: ["dotnet", "build", "--nologo"],
			test: ["dotnet", "test", "--nologo"],
		}
	}
	if (existsSync(join(root, "Cargo.toml"))) {
		return {
			kind: "cargo",
			build: ["cargo", "build", "--locked"],
			test: ["cargo", "test", "--locked"],
		}
	}
	if (existsSync(join(root, "go.mod"))) {
		return {
			kind: "go",
			build: ["go", "build", "./..."],
			test: ["go", "test", "./..."],
		}
	}
	if (existsSync(join(root, "package.json"))) {
		const s = npmScripts(root)
		return {
			kind: "npm",
			build: s.has("build") ? ["npm", "run", "build", "--silent"] : undefined,
			test: s.has("test") ? ["npm", "test", "--silent"] : undefined,
		}
	}
	if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "tox.ini"))) {
		return { kind: "python", test: ["python", "-m", "pytest", "-q"] }
	}
	if (existsSync(join(root, "pom.xml"))) {
		return {
			kind: "maven",
			build: ["mvn", "-q", "-B", "compile"],
			test: ["mvn", "-q", "-B", "test"],
		}
	}
	return { kind: "unknown" }
}

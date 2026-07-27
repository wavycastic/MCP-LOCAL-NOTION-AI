import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Toolchain = {
	kind: string
	build?: string[]
	test?: string[]
	lint?: string[]
	typecheck?: string[]
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
 * Doan build/test/lint/typecheck cmd tu file dac trung o root repo.
 * Chi tra ve argv co dinh — khong bao gio ghep tu input cua agent.
 * Repo nao can lenh khac thi khai bao tuong minh trong repos.json.
 */
export function detectToolchain(root: string): Toolchain {
	if (hasExt(root, ".sln") || hasExt(root, ".slnx") || hasExt(root, ".csproj")) {
		return {
			kind: "dotnet",
			build: ["dotnet", "build", "--nologo"],
			test: ["dotnet", "test", "--nologo"],
			lint: ["dotnet", "format", "--verify-no-changes"],
			typecheck: ["dotnet", "build", "--no-incremental", "--nologo"],
		}
	}
	if (existsSync(join(root, "Cargo.toml"))) {
		return {
			kind: "cargo",
			build: ["cargo", "build", "--locked"],
			test: ["cargo", "test", "--locked"],
			lint: ["cargo", "clippy", "--locked"],
			typecheck: ["cargo", "check", "--locked"],
		}
	}
	if (existsSync(join(root, "go.mod"))) {
		return {
			kind: "go",
			build: ["go", "build", "./..."],
			test: ["go", "test", "./..."],
			lint: ["golangci-lint", "run"],
			typecheck: ["go", "vet", "./..."],
		}
	}
	if (existsSync(join(root, "package.json"))) {
		const s = npmScripts(root)
		// --silent phai dung TRUOC ten script, khong thi npm truyen no cho script.
		return {
			kind: "npm",
			build: s.has("build") ? ["npm", "run", "--silent", "build"] : undefined,
			test: s.has("test") ? ["npm", "run", "--silent", "test"] : undefined,
			lint: s.has("lint") ? ["npm", "run", "--silent", "lint"] : undefined,
			typecheck: s.has("typecheck")
				? ["npm", "run", "--silent", "typecheck"]
				: s.has("tsc")
					? ["npm", "run", "--silent", "tsc"]
					: existsSync(join(root, "tsconfig.json"))
						? ["npx", "tsc", "--noEmit"]
						: undefined,
		}
	}
	if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "tox.ini"))) {
		return {
			kind: "python",
			test: ["python", "-m", "pytest", "-q"],
			lint:
				existsSync(join(root, "ruff.toml")) || existsSync(join(root, ".ruff.toml"))
					? ["ruff", "check", "."]
					: existsSync(join(root, ".flake8"))
						? ["flake8", "."]
						: undefined,
			typecheck:
				existsSync(join(root, "mypy.ini")) || existsSync(join(root, ".mypy.ini"))
					? ["mypy", "."]
					: undefined,
		}
	}
	if (existsSync(join(root, "pom.xml"))) {
		return {
			kind: "maven",
			build: ["mvn", "-q", "-B", "compile"],
			test: ["mvn", "-q", "-B", "test"],
			typecheck: ["mvn", "-q", "-B", "compile"],
		}
	}
	return { kind: "unknown" }
}

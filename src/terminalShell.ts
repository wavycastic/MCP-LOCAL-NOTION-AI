export type ShellKind = "cmd" | "powershell" | "pwsh" | "bash" | "sh"

export function buildShellArgv(command: string, chosenShell?: ShellKind): string[] {
	if (chosenShell) {
		switch (chosenShell) {
			case "cmd": return ["cmd", "/d", "/s", "/c", command]
			case "powershell": return ["powershell", "-NoLogo", "-NoProfile", "-Command", command]
			case "pwsh": return ["pwsh", "-NoLogo", "-NoProfile", "-Command", command]
			case "bash": return ["bash", "--noprofile", "--norc", "-c", command]
			case "sh": return ["sh", "-c", command]
		}
	}
	return process.platform === "win32"
		? ["cmd", "/d", "/s", "/c", command]
		: ["sh", "-c", command]
}

export function buildPtySpawn(command?: string, chosenShell?: ShellKind): { file: string; args: string[]; shell: ShellKind } {
	const shell = chosenShell ?? (process.platform === "win32" ? "cmd" : "sh")
	switch (shell) {
		case "cmd":
			return { file: process.env.ComSpec || "cmd.exe", args: command ? ["/d", "/s", "/c", command] : ["/d"], shell }
		case "powershell":
			return { file: "powershell.exe", args: command ? ["-NoLogo", "-NoProfile", "-Command", command] : ["-NoLogo", "-NoProfile"], shell }
		case "pwsh":
			return { file: "pwsh", args: command ? ["-NoLogo", "-NoProfile", "-Command", command] : ["-NoLogo", "-NoProfile"], shell }
		case "bash":
			return { file: "bash", args: command ? ["--noprofile", "--norc", "-c", command] : ["--noprofile", "--norc", "-i"], shell }
		case "sh":
			return { file: "sh", args: command ? ["-c", command] : ["-i"], shell }
	}
}

const { copyFileSync, existsSync, mkdirSync } = require("node:fs")
const { join } = require("node:path")

const gui = join(process.cwd(), "dist", "gui")
if (!existsSync(gui)) mkdirSync(gui, { recursive: true })

copyFileSync(join(process.cwd(), "src", "gui", "renderer.html"), join(gui, "renderer.html"))
copyFileSync(join(process.cwd(), "src", "gui", "preload.cjs"), join(gui, "preload.cjs"))
const iconSrc = join(process.cwd(), "src", "gui", "icon.png")
if (existsSync(iconSrc)) {
	copyFileSync(iconSrc, join(gui, "icon.png"))
}

const reposSrc = join(process.cwd(), "repos.json")
if (existsSync(reposSrc)) {
	copyFileSync(reposSrc, join(process.cwd(), "dist", "repos.json"))
}
const envSrc = join(process.cwd(), ".env")
if (existsSync(envSrc)) {
	copyFileSync(envSrc, join(process.cwd(), "dist", ".env"))
}

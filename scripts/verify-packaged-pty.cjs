const { resolve } = require("node:path")

const appDir = resolve(process.argv[2] || "release-pty-test/win-unpacked/resources/app")
const pty = require(resolve(appDir, "node_modules/node-pty"))
const isWindows = process.platform === "win32"
const file = isWindows ? process.env.ComSpec || "cmd.exe" : "sh"
const args = isWindows ? ["/d", "/c", "echo ELECTRON_PTY_OK"] : ["-c", "echo ELECTRON_PTY_OK"]
const child = pty.spawn(file, args, {
  cols: 80,
  rows: 24,
  ...(isWindows ? { useConpty: true, useConptyDll: true } : {}),
})
let output = ""
const timer = setTimeout(() => {
  try { child.kill() } catch {}
  console.error("Packaged PTY verification timed out")
  process.exit(1)
}, 10_000)

child.onData((data) => { output += data })
child.onExit(() => {
  clearTimeout(timer)
  if (!output.includes("ELECTRON_PTY_OK")) {
    console.error(`Packaged PTY output mismatch: ${JSON.stringify(output)}`)
    process.exit(1)
  }
  console.log("ELECTRON_PTY_OK")
  process.exit(0)
})

import http from "node:http";
import { spawn, execSync } from "node:child_process";

const TARGET_PORT = 3001;
const PROXY_PORT = 3000;
const AUTH_TOKEN = process.argv[2] || process.env.AUTH_TOKEN || "f6e87a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f";

// Helper to kill process tree on Windows/Unix
function killChild(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {}
  } else {
    child.kill("SIGKILL");
  }
}

// Auto cleanup orphaned process listening on TARGET_PORT before starting
if (process.platform === "win32") {
  try {
    const out = execSync(`netstat -ano | findstr :${TARGET_PORT}`, { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && !isNaN(Number(pid)) && Number(pid) > 0) {
        execSync(`taskkill /pid ${pid} /F`, { stdio: "ignore" });
      }
    }
  } catch {}
}

console.log(`Starting gitnexus on port ${TARGET_PORT}...`);
const isWin = process.platform === "win32";
const cmd = isWin ? (process.env.ComSpec || "cmd.exe") : "npx";
const args = isWin 
  ? ["/c", "npx", "gitnexus", "mcp", "--http", "--host", "127.0.0.1", "--port", String(TARGET_PORT), "--auth-token", AUTH_TOKEN]
  : ["gitnexus", "mcp", "--http", "--host", "127.0.0.1", "--port", String(TARGET_PORT), "--auth-token", AUTH_TOKEN];

const gitnexus = spawn(cmd, args, {
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  windowsHide: true
});

gitnexus.stdout?.on("data", (d) => process.stdout.write(d));
gitnexus.stderr?.on("data", (d) => process.stderr.write(d));

gitnexus.on("exit", (code) => {
  console.error(`gitnexus process exited with code ${code}`);
  process.exit(code || 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killChild(gitnexus);
    process.exit(0);
  });
}

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  headers.accept = "application/json, text/event-stream";
  headers.host = `127.0.0.1:${TARGET_PORT}`;

  const options = {
    hostname: "127.0.0.1",
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad Gateway");
    }
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`GitNexus header-fix proxy listening on http://0.0.0.0:${PROXY_PORT} -> http://127.0.0.1:${TARGET_PORT}`);
});

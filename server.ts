import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { RpcSession } from "./rpc.js";
import { listSessions, readSessionMessages } from "./sessions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
pi-web - Web UI for the pi coding agent

Usage: pi-web [options]

Options:
  --port <number>   Port to listen on (default: 8192, env: PORT)
  --host <string>   Host to bind to (default: 127.0.0.1, env: HOST)
  -h, --help        Show this help message
  `.trim());
  process.exit(0);
}

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const pair = process.argv.find((a) => a.startsWith(flag));
  if (pair) return pair.slice(flag.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) return process.argv[idx + 1];
  return undefined;
}

const PORT = parseInt(getArg("port") || process.env.PORT || "8192", 10);
const HOST = getArg("host") || process.env.HOST || "127.0.0.1";
const PI_CMD = process.env.PI_CMD || "npx -y @mariozechner/pi-coding-agent@latest";
const isDev = process.argv.includes("--watch") || process.env.NODE_ENV === "development";

const distDir = join(__dirname, "dist");
const htmlPath = join(distDir, "index.html");
const htmlCache = isDev || !existsSync(htmlPath) ? null : readFileSync(htmlPath, "utf-8");

const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveFile(filePath: string, res: any) {
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    if (!existsSync(htmlPath)) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Frontend not built. Run: npm run build");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(htmlCache ?? readFileSync(htmlPath, "utf-8"));
    return;
  }

  if (req.url === "/api/sessions") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cwd = url.searchParams.get("cwd") || undefined;
    listSessions({ cwd, limit: 50 })
      .then((data) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }

  if (req.url?.startsWith("/api/session?")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const file = url.searchParams.get("file");
    if (!file) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "file parameter required" }));
      return;
    }

    if (req.method === "DELETE") {
      try {
        unlinkSync(file);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    readSessionMessages(file)
      .then((messages) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(messages));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }

  if (req.url) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const safePath = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    const filePath = join(distDir, safePath);
    if (filePath.startsWith(distDir) && existsSync(filePath) && statSync(filePath).isFile()) {
      serveFile(filePath, res);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server });
const rpcSessions = new Map<WebSocket, RpcSession>();

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === "start_session") {
      rpcSessions.get(ws)?.kill();
      const rpc = new RpcSession({
        piCmd: PI_CMD,
        cwd: msg.cwd || process.env.HOME || "/",
        sessionFile: msg.sessionFile || undefined,
        onEvent: (event) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "rpc_event", event }));
        },
        onError: (error) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: error }));
        },
        onExit: (code) => {
          rpcSessions.delete(ws);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "session_ended", code }));
        },
      });
      rpcSessions.set(ws, rpc);
      return;
    }

    if (msg.type === "rpc_command") {
      const rpc = rpcSessions.get(ws);
      if (!rpc) { ws.send(JSON.stringify({ type: "error", message: "No active session" })); return; }
      rpc.send(msg.command);
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  });

  ws.on("close", () => {
    rpcSessions.get(ws)?.kill();
    rpcSessions.delete(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`pi-web running at http://${HOST}:${PORT}`);
});

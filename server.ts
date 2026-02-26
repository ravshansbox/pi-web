import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { RpcSession } from "./rpc.ts";
import { listSessions, cwdToSessionDir, readSessionMessages } from "./sessions.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3100", 10);
const PI_CMD = process.env.PI_CMD || "npx -y @mariozechner/pi-coding-agent@latest";

const html = readFileSync(join(__dirname, "index.html"), "utf-8");

const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
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

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server });

// Track active RPC sessions by WebSocket
const rpcSessions = new Map<WebSocket, RpcSession>();

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "start_session") {
      // Kill old session if any
      rpcSessions.get(ws)?.kill();

      const cwd = msg.cwd || process.env.HOME || "/";
      const sessionFile = msg.sessionFile || undefined;

      const rpc = new RpcSession({
        piCmd: PI_CMD,
        cwd,
        sessionFile,
        onEvent: (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "rpc_event", event }));
          }
        },
        onError: (error) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: error }));
          }
        },
        onExit: (code) => {
          rpcSessions.delete(ws);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "session_ended", code }));
          }
        },
      });

      rpcSessions.set(ws, rpc);
      return;
    }

    if (msg.type === "rpc_command") {
      const rpc = rpcSessions.get(ws);
      if (!rpc) {
        ws.send(JSON.stringify({ type: "error", message: "No active session" }));
        return;
      }
      rpc.send(msg.command);
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
  });

  ws.on("close", () => {
    rpcSessions.get(ws)?.kill();
    rpcSessions.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`pi-web running at http://localhost:${PORT}`);
});

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RpcSession } from './rpc.js';
import { listSessions, readSessionMessages, getSessionFilePath, type AgentKind } from './sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    `
pi-web - Web UI for the pi coding agent

Usage: pi-web [options]

Options:
  --port <number>      Port to listen on (default: 8192, env: PORT)
  --host <string>      Host to bind to (default: 127.0.0.1, env: HOST)
  --agent <pi|omp>     Agent backend profile (default: pi)
  -h, --help           Show this help message
  `.trim(),
  );
  process.exit(0);
}

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const pair = process.argv.find((a) => a.startsWith(flag));
  if (pair) return pair.slice(flag.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--'))
    return process.argv[idx + 1];
  return undefined;
}

function parseAgent(value?: string): AgentKind {
  const agent = (value || 'pi').toLowerCase();
  if (agent === 'pi' || agent === 'omp') return agent;
  console.error(`invalid --agent value "${value}". expected "pi" or "omp"`);
  process.exit(1);
}

function getAgentCommand(agent: AgentKind): string {
  return agent === 'omp'
    ? 'npx -y @oh-my-pi/pi-coding-agent@latest'
    : 'npx -y @mariozechner/pi-coding-agent@latest';
}

const AGENT = parseAgent(getArg('agent'));
const PORT = parseInt(getArg('port') || process.env.PORT || '8192', 10);
const HOST = getArg('host') || process.env.HOST || '127.0.0.1';
const AGENT_CMD = getAgentCommand(AGENT);
const DEFAULT_IDLE_SESSION_TTL_MS = 60_000;
const idleSessionTtlMsEnv = parseInt(process.env.PI_WEB_IDLE_SESSION_TTL_MS || '', 10);
const IDLE_SESSION_TTL_MS =
  Number.isFinite(idleSessionTtlMsEnv) && idleSessionTtlMsEnv >= 0
    ? idleSessionTtlMsEnv
    : DEFAULT_IDLE_SESSION_TTL_MS;
const isWatchMode =
  process.argv.includes('--watch') ||
  process.execArgv.some((arg) => arg === '--watch' || arg.startsWith('--watch-')) ||
  process.env.WATCH_REPORT_DEPENDENCIES != null;
const isDev = process.env.NODE_ENV === 'development' || isWatchMode;

const distDirCandidates = [join(__dirname, 'dist'), join(__dirname, '..', '..', 'dist')];
const distDir =
  distDirCandidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ??
  distDirCandidates[0];
const htmlPath = join(distDir, 'index.html');
const htmlCache = isDev || !existsSync(htmlPath) ? null : readFileSync(htmlPath, 'utf-8');
const HOME_DIR = resolve(process.env.HOME || '/');

type FolderEntry = {
  name: string;
  path: string;
};

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function listFolders(cwdQuery?: string | null): Promise<{
  cwd: string;
  root: string;
  folders: FolderEntry[];
  error?: string;
}> {
  const requested = cwdQuery ? resolve(cwdQuery) : HOME_DIR;
  const cwd = isWithinRoot(requested, HOME_DIR) ? requested : HOME_DIR;

  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const folders = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: join(cwd, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { cwd, root: HOME_DIR, folders };
  } catch (err) {
    return {
      cwd,
      root: HOME_DIR,
      folders: [],
      error: `unable to read ${cwd}: ${String(err)}`,
    };
  }
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveFile(filePath: string, res: any) {
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    if (!existsSync(htmlPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('frontend not built. run: npm run build');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(htmlCache ?? readFileSync(htmlPath, 'utf-8'));
    return;
  }

  if (req.url?.startsWith('/api/sessions')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cwd = url.searchParams.get('cwd') || undefined;
    listSessions({ cwd, limit: 50, agent: AGENT })
      .then((data) => {
        const sessionsWithRuntime = data.map((session) => ({
          ...session,
          ...getSessionRuntimeStatus(session.cwd, session.file),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessionsWithRuntime));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }

  if (req.url?.startsWith('/api/folders')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cwd = url.searchParams.get('cwd');

    listFolders(cwd)
      .then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }

  if (req.url?.startsWith('/api/session?')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cwd = url.searchParams.get('cwd');
    const filename = url.searchParams.get('filename');
    if (!cwd || !filename) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cwd and filename parameters required' }));
      return;
    }
    const file = getSessionFilePath(cwd, filename, AGENT);

    if (req.method === 'DELETE') {
      try {
        unlinkSync(file);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    readSessionMessages(file)
      .then((messages) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messages));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }

  if (req.url) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const safePath = normalize(url.pathname)
      .replace(/^(\.\.[/\\])+/, '')
      .replace(/^[/\\]+/, '');
    const filePath = join(distDir, safePath);
    if (filePath.startsWith(distDir) && existsSync(filePath) && statSync(filePath).isFile()) {
      serveFile(filePath, res);
      return;
    }

    const acceptsHtml = (req.headers.accept ?? '').includes('text/html');
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && acceptsHtml) {
      if (!existsSync(htmlPath)) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('frontend not built. run: npm run build');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlCache ?? readFileSync(htmlPath, 'utf-8'));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server });

type ManagedRpcSession = {
  cwd: string;
  sessionFile: string | null;
  rpc: RpcSession;
  clients: Set<WebSocket>;
  isAgentRunning: boolean;
  currentModelSupportsImages: boolean | null;
  keys: Set<string>;
  idleCleanupTimer: NodeJS.Timeout | null;
  isClosing: boolean;
};

const rpcSessions = new Map<string, ManagedRpcSession>();
const socketBindings = new Map<WebSocket, ManagedRpcSession>();

function buildSessionKey(cwd: string, sessionFile: string | null): string {
  return `${cwd}::${sessionFile ? basename(sessionFile) : '__new__'}`;
}

function getSessionRuntimeStatus(cwd: string, sessionFile: string): {
  isActive: boolean;
  isWorking: boolean;
} {
  const key = buildSessionKey(resolve(cwd), basename(sessionFile));
  const managed = rpcSessions.get(key);
  if (!managed || managed.isClosing) return { isActive: false, isWorking: false };
  return {
    isActive: managed.isAgentRunning || managed.clients.size > 0,
    isWorking: managed.isAgentRunning,
  };
}

function sendToSocket(ws: WebSocket, payload: any) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcast(managed: ManagedRpcSession, payload: any) {
  for (const client of managed.clients) {
    sendToSocket(client, payload);
  }
}

function clearIdleCleanupTimer(managed: ManagedRpcSession) {
  if (!managed.idleCleanupTimer) return;
  clearTimeout(managed.idleCleanupTimer);
  managed.idleCleanupTimer = null;
}

function unregisterManagedSession(managed: ManagedRpcSession) {
  for (const key of managed.keys) {
    if (rpcSessions.get(key) === managed) rpcSessions.delete(key);
  }
  managed.keys.clear();
}

function registerManagedSessionKey(managed: ManagedRpcSession, key: string) {
  managed.keys.add(key);
  rpcSessions.set(key, managed);
}

function closeManagedSession(managed: ManagedRpcSession) {
  if (managed.isClosing) return;
  managed.isClosing = true;
  clearIdleCleanupTimer(managed);
  unregisterManagedSession(managed);
  managed.rpc.kill();
}

function cleanupIfIdle(managed: ManagedRpcSession) {
  if (managed.isClosing) return;
  if (managed.clients.size > 0) {
    clearIdleCleanupTimer(managed);
    return;
  }
  if (managed.isAgentRunning) {
    clearIdleCleanupTimer(managed);
    return;
  }
  if (managed.idleCleanupTimer) return;

  managed.idleCleanupTimer = setTimeout(() => {
    managed.idleCleanupTimer = null;
    if (managed.isClosing) return;
    if (managed.clients.size > 0) return;
    if (managed.isAgentRunning) return;
    closeManagedSession(managed);
  }, IDLE_SESSION_TTL_MS);
}

function detachSocket(ws: WebSocket) {
  const current = socketBindings.get(ws);
  if (!current) return;
  current.clients.delete(ws);
  socketBindings.delete(ws);
  cleanupIfIdle(current);
}

function registerDiscoveredSessionKey(managed: ManagedRpcSession, event: any) {
  if (event?.type !== 'response' || event?.command !== 'get_state') return;
  const sessionPath = event?.data?.sessionFile;
  if (typeof sessionPath !== 'string' || sessionPath.length === 0) return;
  const key = buildSessionKey(managed.cwd, basename(sessionPath));
  registerManagedSessionKey(managed, key);
}

function deriveModelSupportsImages(model: unknown): boolean | null {
  if (!model || typeof model !== 'object') return null;
  const input = (model as { input?: unknown }).input;
  if (!Array.isArray(input)) return null;
  return input.includes('image');
}

function updateSessionModelCapability(managed: ManagedRpcSession, event: any) {
  if (!event || typeof event !== 'object') return;

  if (event.type === 'model_changed') {
    const supports = deriveModelSupportsImages(event.model);
    if (supports != null) managed.currentModelSupportsImages = supports;
    return;
  }

  if (event.type === 'response') {
    if (event.command === 'get_state') {
      const supports = deriveModelSupportsImages(event.data?.model);
      if (supports != null) managed.currentModelSupportsImages = supports;
      return;
    }

    if (event.command === 'set_model' && event.success) {
      const supports = deriveModelSupportsImages(event.data);
      if (supports != null) managed.currentModelSupportsImages = supports;
    }
  }
}

function createManagedSession(cwd: string, sessionFile: string | null): ManagedRpcSession {
  const sessionPath = sessionFile ? getSessionFilePath(cwd, sessionFile, AGENT) : undefined;
  let managed: ManagedRpcSession | null = null;

  const rpc = new RpcSession({
    piCmd: AGENT_CMD,
    cwd,
    sessionFile: sessionPath,
    onEvent: (event) => {
      if (!managed) return;
      if (event?.type === 'agent_start') {
        managed.isAgentRunning = true;
        clearIdleCleanupTimer(managed);
      }
      if (event?.type === 'agent_end') {
        managed.isAgentRunning = false;
        cleanupIfIdle(managed);
      }
      updateSessionModelCapability(managed, event);
      registerDiscoveredSessionKey(managed, event);
      broadcast(managed, { type: 'rpc_event', event });
    },
    onError: (error) => {
      if (!managed) return;
      broadcast(managed, { type: 'error', message: error });
    },
    onExit: (code) => {
      if (!managed) return;
      managed.isAgentRunning = false;
      managed.isClosing = true;
      clearIdleCleanupTimer(managed);
      unregisterManagedSession(managed);
      broadcast(managed, { type: 'session_ended', code });
      for (const client of managed.clients) {
        if (socketBindings.get(client) === managed) socketBindings.delete(client);
      }
      managed.clients.clear();
    },
  });

  managed = {
    cwd,
    sessionFile,
    rpc,
    clients: new Set<WebSocket>(),
    isAgentRunning: false,
    currentModelSupportsImages: null,
    keys: new Set<string>(),
    idleCleanupTimer: null,
    isClosing: false,
  };

  registerManagedSessionKey(managed, buildSessionKey(cwd, sessionFile));
  return managed;
}

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === 'start_session') {
      const cwd =
        typeof msg.cwd === 'string' && msg.cwd.trim().length > 0
          ? resolve(msg.cwd)
          : resolve(process.env.HOME || '/');
      const sessionFile =
        typeof msg.sessionFile === 'string' && msg.sessionFile.length > 0
          ? basename(msg.sessionFile)
          : null;
      const key = buildSessionKey(cwd, sessionFile);

      const currentlyBound = socketBindings.get(ws);
      if (currentlyBound?.keys.has(key)) {
        clearIdleCleanupTimer(currentlyBound);
        return;
      }

      detachSocket(ws);

      let managed = rpcSessions.get(key);
      if (!managed || managed.isClosing) managed = createManagedSession(cwd, sessionFile);

      managed.clients.add(ws);
      clearIdleCleanupTimer(managed);
      socketBindings.set(ws, managed);
      return;
    }

    if (msg.type === 'detach_session') {
      detachSocket(ws);
      return;
    }

    if (msg.type === 'rpc_command') {
      const managed = socketBindings.get(ws);
      if (!managed) {
        sendToSocket(ws, { type: 'error', message: 'no active session' });
        return;
      }

      const command = msg.command;
      const isPromptLikeCommand =
        command?.type === 'prompt' || command?.type === 'steer' || command?.type === 'follow_up';
      const hasImages = Array.isArray(command?.images) && command.images.length > 0;
      if (
        isPromptLikeCommand &&
        hasImages &&
        managed.currentModelSupportsImages === false
      ) {
        sendToSocket(ws, {
          type: 'error',
          message: 'selected model does not support file attachments',
        });
        return;
      }

      managed.rpc.send(command);
      return;
    }

    if (msg.type === 'ping') {
      sendToSocket(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => {
    detachSocket(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`pi-web running at http://${HOST}:${PORT}`);
});

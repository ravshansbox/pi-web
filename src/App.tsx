import { useEffect, useMemo, useRef, useState } from 'react';

import { useLocation, useNavigate } from 'react-router-dom';
type SessionSummary = {
  id: string;
  file: string;
  cwd: string;
  timestamp: string;
  firstPrompt?: string;
  messageCount: number;
  isActive?: boolean;
  isWorking?: boolean;
};

type MessagePart = {
  type: 'text' | 'thinking' | 'tool';
  content?: string;
  name?: string;
  args?: unknown;
  done?: boolean;
  id?: string;
  details?: unknown;
  isError?: boolean;
};

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type MessageEntry = {
  id: string;
  role: string;
  parts: MessagePart[];
  model?: string;
  provider?: string;
  timestamp?: number;
  usage?: Usage;
};

type ParsedMessage = {
  id: string;
  role: string;
  content: any;
  timestamp?: string;
  model?: string;
  provider?: string;
  usage?: Usage;
};

type FolderEntry = {
  name: string;
  path: string;
};

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type Model = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

type SessionStats = {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
};

const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const EXTERNAL_SESSION_SYNC_INTERVAL_MS = 1200;

function asHomeRelativePath(cwd: string): string {
  return cwd
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~');
}

function shortenCwd(cwd: string): string {
  const home = asHomeRelativePath(cwd);
  const parts = home.split('/').filter(Boolean);
  if (parts.length <= 2) return home;
  return '~/../' + parts[parts.length - 1];
}

const NEW_SESSION_ROUTE_PARAM = '__new__';

function encodeRouteParam(raw: string): string {
  return encodeURIComponent(raw);
}

function decodeRouteParam(param: string | undefined): string | null {
  if (param == null) return null;
  try {
    return decodeURIComponent(param);
  } catch {
    return null;
  }
}

function projectRoutePath(cwd: string): string {
  return `/${encodeRouteParam(cwd)}`;
}

function sessionRoutePath(cwd: string, sessionFile: string): string {
  return `/${encodeRouteParam(cwd)}/${encodeRouteParam(sessionFile)}`;
}

function newSessionRoutePath(cwd: string): string {
  return `/${encodeRouteParam(cwd)}/${NEW_SESSION_ROUTE_PARAM}`;
}

function projectsRoutePath(cwd?: string | null): string {
  return cwd ? `/?cwd=${encodeURIComponent(cwd)}` : '/';
}

function normaliseThinkingLevel(value: unknown): ThinkingLevel | null {
  if (typeof value !== 'string') return null;
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : null;
}

function getInitialFolderBrowserCwdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('cwd');
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ANSI_ESCAPE_PATTERN =
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return null;
}

function replaceTabs(value: string): string {
  return value.replace(/\t/g, '   ');
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sanitizeBinaryOutput(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join('');
}

function normaliseToolOutputText(value: string): string {
  return replaceTabs(sanitizeBinaryOutput(value.replace(ANSI_ESCAPE_PATTERN, '')).replace(/\r/g, ''));
}

function extractToolText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const textBlocks = value
      .map((item) => {
        const itemRecord = asRecord(item);
        if (itemRecord?.type === 'text') return toolString(itemRecord.text) ?? '';
        return '';
      })
      .filter(Boolean);

    if (textBlocks.length > 0) return textBlocks.join('\n');

    const joined = value
      .map((item) => extractToolText(item))
      .filter((item) => item.length > 0)
      .join('\n');
    if (joined) return joined;

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }

  const record = asRecord(value);
  if (record) {
    if (typeof record.text === 'string') return record.text;
    if (typeof record.output === 'string') return record.output;
    if (record.content != null) {
      const contentText = extractToolText(record.content);
      if (contentText) return contentText;
    }
    if (record.result != null) {
      const resultText = extractToolText(record.result);
      if (resultText) return resultText;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }

  return '';
}

function getToolResultEnvelope(value: unknown): { text: string; details?: unknown } {
  const record = asRecord(value);
  if (!record) return { text: extractToolText(value) };

  const contentText = record.content != null ? extractToolText(record.content) : '';
  if (contentText || record.details !== undefined) {
    return { text: contentText, details: record.details };
  }

  const result = record.result;
  if (result !== undefined) {
    const nested = getToolResultEnvelope(result);
    return { text: nested.text, details: nested.details ?? record.details };
  }

  const directText = extractToolText(value);
  return { text: directText, details: record.details };
}

function formatPreviewLines(lines: string[], maxLines: number): string {
  if (lines.length === 0) return '';
  const displayLines = lines.slice(0, maxLines);
  let text = displayLines.join('\n');
  if (lines.length > maxLines) {
    text += `\n... (${lines.length - maxLines} more lines)`;
  }
  return text;
}

function formatTailPreviewLines(lines: string[], maxLines: number): string {
  if (lines.length === 0) return '';
  const displayLines = lines.slice(Math.max(0, lines.length - maxLines));
  let text = displayLines.join('\n');
  if (lines.length > maxLines) {
    text = `... (${lines.length - maxLines} earlier lines)\n${text}`;
  }
  return text;
}

function formatToolExecutionForDisplay(part: MessagePart): string {
  const name = part.name || 'tool';
  const args = asRecord(part.args);
  const output = normaliseToolOutputText(extractToolText(part.content));
  const details = asRecord(part.details);
  const invalidArg = '[invalid arg]';

  if (name === 'bash') {
    const command = toolString(args?.command);
    const timeout = typeof args?.timeout === 'number' ? args.timeout : undefined;
    const commandDisplay = command === null ? invalidArg : command || '...';
    let text = `$ ${commandDisplay}${timeout ? ` (timeout ${timeout}s)` : ''}`;

    const outputLines = output.trim() ? output.trim().split('\n') : [];
    if (outputLines.length > 0) {
      text += `\n\n${formatTailPreviewLines(outputLines, 5)}`;
    }

    const truncation = asRecord(details?.truncation);
    const fullOutputPath = toolString(details?.fullOutputPath);
    if (truncation?.truncated || fullOutputPath) {
      const warnings: string[] = [];
      if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
      if (truncation?.truncated) {
        const outputLines = Number(truncation.outputLines) || 0;
        const totalLines = Number(truncation.totalLines) || 0;
        if (truncation.truncatedBy === 'lines') {
          warnings.push(`Truncated: showing ${outputLines} of ${totalLines} lines`);
        } else {
          warnings.push(
            `Truncated: ${outputLines} lines shown (${formatSize(Number(truncation.maxBytes) || 0)} limit)`,
          );
        }
      }
      text += `\n\n[${warnings.join('. ')}]`;
    }

    return text;
  }

  if (name === 'read') {
    const rawPath = toolString(args?.file_path ?? args?.path);
    const path = rawPath === null ? invalidArg : rawPath ? asHomeRelativePath(rawPath) : '...';
    const offset = typeof args?.offset === 'number' ? args.offset : undefined;
    const limit = typeof args?.limit === 'number' ? args.limit : undefined;
    const range =
      offset !== undefined || limit !== undefined
        ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ''}`
        : '';

    return `read ${path}${range}`;
  }

  if (name === 'ls' || name === 'find' || name === 'grep') {
    const path = toolString(args?.path);
    const basePath = path === null ? invalidArg : asHomeRelativePath(path || '.');
    let text = name;

    if (name === 'find') {
      const pattern = toolString(args?.pattern);
      text = `find ${pattern === null ? invalidArg : pattern || ''} in ${basePath}`;
    } else if (name === 'grep') {
      const pattern = toolString(args?.pattern);
      text = `grep /${pattern === null ? invalidArg : pattern || ''}/ in ${basePath}`;
      const glob = toolString(args?.glob);
      if (glob) text += ` (${glob})`;
    } else {
      text = `ls ${basePath}`;
    }

    const limit = typeof args?.limit === 'number' ? args.limit : undefined;
    if (limit !== undefined) {
      text += name === 'grep' ? ` limit ${limit}` : ` (limit ${limit})`;
    }

    const previewLimit = name === 'grep' ? 15 : 20;
    if (output.trim()) {
      text += `\n\n${formatPreviewLines(output.trim().split('\n'), previewLimit)}`;
    }

    const truncation = asRecord(details?.truncation);
    const warnings: string[] = [];

    if (name === 'ls') {
      const entryLimit =
        typeof details?.entryLimitReached === 'number' ? details.entryLimitReached : undefined;
      if (entryLimit) warnings.push(`${entryLimit} entries limit`);
    } else if (name === 'find') {
      const resultLimit =
        typeof details?.resultLimitReached === 'number' ? details.resultLimitReached : undefined;
      if (resultLimit) warnings.push(`${resultLimit} results limit`);
    } else if (name === 'grep') {
      const matchLimit =
        typeof details?.matchLimitReached === 'number' ? details.matchLimitReached : undefined;
      if (matchLimit) warnings.push(`${matchLimit} matches limit`);
      if (Boolean(details?.linesTruncated)) warnings.push('some lines truncated');
    }

    if (truncation?.truncated) {
      warnings.push(`${formatSize(Number(truncation.maxBytes) || 0)} limit`);
    }

    if (warnings.length > 0) {
      text += `\n[Truncated: ${warnings.join(', ')}]`;
    }

    return text;
  }

  if (name === 'write') {
    const rawPath = toolString(args?.file_path ?? args?.path);
    const content = toolString(args?.content);
    const path = rawPath === null ? invalidArg : rawPath ? asHomeRelativePath(rawPath) : '...';
    let text = `write ${path}`;

    if (content === null) {
      text += `\n\n[invalid content arg - expected string]`;
    } else if (content) {
      text += `\n\n${formatPreviewLines(replaceTabs(content).split('\n'), 10)}`;
    }

    if (part.isError && output) {
      text += `\n\n${output}`;
    }

    return text;
  }

  if (name === 'edit') {
    const rawPath = toolString(args?.file_path ?? args?.path);
    const path = rawPath === null ? invalidArg : rawPath ? asHomeRelativePath(rawPath) : '...';
    const firstChangedLine = details?.firstChangedLine;
    const lineSuffix = typeof firstChangedLine === 'number' ? `:${firstChangedLine}` : '';
    let text = `edit ${path}${lineSuffix}`;

    const diff = typeof details?.diff === 'string' ? details.diff : '';
    if (part.isError) {
      if (output) text += `\n\n${output}`;
      return text;
    }

    if (diff) {
      text += `\n\n${normaliseToolOutputText(diff)}`;
      return text;
    }

    if (output) text += `\n\n${output}`;
    return text;
  }

  let text = name;
  if (args) {
    try {
      text += `\n\n${JSON.stringify(args, null, 2)}`;
    } catch {
      text += '\n\n[unable to serialise args]';
    }
  }
  if (output) text += `\n\n${output}`;
  return text;
}

export default function App() {
  const navigate = useNavigate();
  const routeLocation = useLocation();

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentMessages, setCurrentMessages] = useState<MessageEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [hasActiveSession, setHasActiveSession] = useState(false);
  const [folderBrowserCwd, setFolderBrowserCwd] = useState<string | null>(
    getInitialFolderBrowserCwdFromUrl,
  );
  const [folderBrowserRoot, setFolderBrowserRoot] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [isFolderBrowserLoading, setIsFolderBrowserLoading] = useState(false);
  const [folderBrowserError, setFolderBrowserError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [currentModel, setCurrentModel] = useState<Model | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('off');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [promptQueue, setPromptQueue] = useState<string[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [hasLoadedSessions, setHasLoadedSessions] = useState(false);

  const pathSegments = useMemo(
    () => routeLocation.pathname.split('/').filter(Boolean),
    [routeLocation.pathname],
  );
  const projectIdParam = pathSegments[0];
  const sessionIdParam = pathSegments[1];
  const hasExtraPathSegments = pathSegments.length > 2;
  const selectedProjectCwd = useMemo(() => decodeRouteParam(projectIdParam), [projectIdParam]);
  const activeSessionFile = useMemo(() => {
    if (sessionIdParam == null || sessionIdParam === NEW_SESSION_ROUTE_PARAM) return null;
    return decodeRouteParam(sessionIdParam);
  }, [sessionIdParam]);
  const isProjectsView = pathSegments.length === 0;
  const isSessionsView = pathSegments.length === 1;
  const isHistoryView = pathSegments.length === 2;
  const isNewSessionRoute = sessionIdParam === NEW_SESSION_ROUTE_PARAM;
  const folderCwdFromQuery = useMemo(() => {
    const raw = new URLSearchParams(routeLocation.search).get('cwd');
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }, [routeLocation.search]);

  const wsRef = useRef<WebSocket | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const modelsRetryRef = useRef<number | null>(null);
  const availableModelsRef = useRef<Model[]>([]);
  const currentModelRef = useRef<Model | null>(null);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const activeSessionFileRef = useRef<string | null>(null);
  const hasActiveSessionRef = useRef(false);
  const pendingSessionRef = useRef<{ cwd?: string; sessionFile?: string | null } | null>(null);
  const sessionRouteSyncAttemptsRef = useRef<Map<string, { cwd: string; attemptsLeft: number }>>(
    new Map(),
  );
  const isNewSessionRouteRef = useRef(false);
  const activeRpcSessionRef = useRef<{ cwd?: string; sessionFile: string | null } | null>(null);
  const selectedProjectCwdRef = useRef<string | null>(null);
  const syncNavigatedRef = useRef(false);
  const isStreamingRef = useRef(false);
  const externalSessionSyncTimerRef = useRef<number | null>(null);
  const externalSessionSyncAbortRef = useRef<AbortController | null>(null);
  const externalSessionSyncInFlightRef = useRef(false);
  const lastExternalSessionSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeSessionFileRef.current = activeSessionFile;
  }, [activeSessionFile]);
  useEffect(() => {
    hasActiveSessionRef.current = hasActiveSession;
  }, [hasActiveSession]);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);
  useEffect(() => {
    availableModelsRef.current = availableModels;
  }, [availableModels]);
  useEffect(() => {
    currentModelRef.current = currentModel;
  }, [currentModel]);
  useEffect(() => {
    selectedProjectCwdRef.current = selectedProjectCwd;
  }, [selectedProjectCwd]);
  useEffect(() => {
    isNewSessionRouteRef.current = isNewSessionRoute;
  }, [isNewSessionRoute]);
  useEffect(() => {
    if (!isNewSessionRoute) sessionRouteSyncAttemptsRef.current.clear();
  }, [isNewSessionRoute]);

  useEffect(() => {
    if (!isProjectsView) return;
    setFolderBrowserCwd((prev) => (prev === folderCwdFromQuery ? prev : folderCwdFromQuery));
  }, [folderCwdFromQuery, isProjectsView]);

  useEffect(() => {
    connect();
    loadSessions();
    return () => {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
      if (externalSessionSyncTimerRef.current)
        window.clearInterval(externalSessionSyncTimerRef.current);
      externalSessionSyncTimerRef.current = null;
      externalSessionSyncAbortRef.current?.abort();
      externalSessionSyncAbortRef.current = null;
      externalSessionSyncInFlightRef.current = false;
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!isSessionsView) return;
    void loadSessions();
  }, [isSessionsView, selectedProjectCwd]);

  useEffect(() => {
    if (!isSessionsView) return;
    const timer = window.setInterval(() => {
      void loadSessions();
    }, EXTERNAL_SESSION_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isSessionsView, selectedProjectCwd]);

  useEffect(() => {
    if (!threadRef.current) return;
    requestAnimationFrame(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    });
  }, [currentMessages, availableModels.length, currentModel?.id, currentModel?.provider]);

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`;
  }, [inputValue]);

  useEffect(() => {
    if (!isHistoryView || !hasActiveSession) return;
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled) return;
      input.focus();
    });
  }, [activeSessionFile, hasActiveSession, isHistoryView, isNewSessionRoute, selectedProjectCwd]);

  useEffect(() => {
    if (isHistoryView) return;
    if (!hasActiveSessionRef.current) return;
    detachSession();
  }, [isHistoryView]);

  useEffect(() => {
    if (!hasExtraPathSegments) return;
    navigate('/', { replace: true });
  }, [hasExtraPathSegments, navigate]);
  useEffect(() => {
    if (projectIdParam == null) return;
    if (selectedProjectCwd == null) {
      navigate('/', { replace: true });
    }
  }, [navigate, projectIdParam, selectedProjectCwd]);

  useEffect(() => {
    if (projectIdParam == null || sessionIdParam == null || isNewSessionRoute) return;
    if (selectedProjectCwd == null) return;
    if (activeSessionFile == null) {
      navigate(projectRoutePath(selectedProjectCwd), { replace: true });
    }
  }, [
    activeSessionFile,
    isNewSessionRoute,
    navigate,
    projectIdParam,
    selectedProjectCwd,
    sessionIdParam,
  ]);

  useEffect(() => {
    if (!selectedProjectCwd || !activeSessionFile || sessionIdParam == null || isNewSessionRoute)
      return;
    const exists = sessions.some(
      (session) => session.cwd === selectedProjectCwd && session.file === activeSessionFile,
    );
    if (!exists && hasLoadedSessions) {
      navigate(projectRoutePath(selectedProjectCwd), { replace: true });
    }
  }, [
    activeSessionFile,
    hasLoadedSessions,
    isNewSessionRoute,
    navigate,
    selectedProjectCwd,
    sessionIdParam,
    sessions,
  ]);

  const providers = useMemo(
    () => Array.from(new Set(availableModels.map((m) => m.provider))),
    [availableModels],
  );

  const modelsForProvider = useMemo(
    () => availableModels.filter((m) => m.provider === selectedProvider),
    [availableModels, selectedProvider],
  );
  const selectedModelId = currentModel?.provider === selectedProvider ? currentModel.id : '';
  const thinkingLevelOptions = useMemo<ThinkingLevel[]>(() => {
    const levels = currentModel?.reasoning === false ? (['off'] as ThinkingLevel[]) : THINKING_LEVELS;
    return levels.includes(thinkingLevel)
      ? levels
      : [thinkingLevel, ...levels.filter((level) => level !== thinkingLevel)];
  }, [currentModel?.reasoning, thinkingLevel]);

  const contextUsageTokens = useMemo(
    () => estimateContextTokens(currentMessages),
    [currentMessages],
  );
  const canNavigateFolderUp = useMemo(() => {
    if (!folderBrowserCwd || !folderBrowserRoot) return false;
    return folderBrowserCwd !== folderBrowserRoot;
  }, [folderBrowserCwd, folderBrowserRoot]);

  const sessionsForSelectedProject = useMemo(
    () =>
      selectedProjectCwd ? sessions.filter((session) => session.cwd === selectedProjectCwd) : [],
    [selectedProjectCwd, sessions],
  );
  function connect() {
    const ws = new WebSocket(WS_BASE);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      if (pendingSessionRef.current) {
        const pending = pendingSessionRef.current;
        if (startSession(pending.cwd, pending.sessionFile ?? null)) {
          scheduleRequestModels();
          requestStats();
        }
        return;
      }
      if (activeSessionFileRef.current || hasActiveSessionRef.current) {
        const file = activeSessionFileRef.current;
        const cwd = file
          ? sessionsRef.current.find((s) => s.file === file)?.cwd
          : (selectedProjectCwdRef.current ?? sessionsRef.current[0]?.cwd);
        if (!file && !cwd) return;
        if (startSession(cwd, file ?? null)) {
          scheduleRequestModels();
          requestStats();
        }
      }
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'rpc_event') handleRpcEvent(msg.event);
      if (msg.type === 'error') {
        console.error('[pi-web]', msg.message);
        if (
          typeof msg.message === 'string' &&
          msg.message.includes('no active session') &&
          (hasActiveSessionRef.current || pendingSessionRef.current)
        ) {
          scheduleRequestModels(150);
          requestStats();
        }
      }
      if (msg.type === 'session_ended') {
        setIsStreaming(false);
        setHasActiveSession(false);
        activeRpcSessionRef.current = null;
        void loadSessions();
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsStreaming(false);
      setHasActiveSession(false);
      pendingSessionRef.current = null;
      sessionRouteSyncAttemptsRef.current.clear();
      activeRpcSessionRef.current = null;
      reconnectTimerRef.current = window.setTimeout(connect, 2000);
    };
  }

  function wsSend(obj: any): boolean {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function requestSessionRouteSync(cwd: string, attemptsLeft = 12): boolean {
    const syncId = `route-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionRouteSyncAttemptsRef.current.set(syncId, { cwd, attemptsLeft });
    const sent = wsSend({ type: 'rpc_command', command: { type: 'get_state', id: syncId } });
    if (!sent) sessionRouteSyncAttemptsRef.current.delete(syncId);
    return sent;
  }

  function startSession(cwd?: string, sessionFile?: string | null): boolean {
    const sent = wsSend({ type: 'start_session', sessionFile: sessionFile ?? undefined, cwd });
    if (!sent) {
      pendingSessionRef.current = { cwd, sessionFile };
      activeRpcSessionRef.current = null;
      setHasActiveSession(false);
      return false;
    }
    pendingSessionRef.current = null;
    activeRpcSessionRef.current = { cwd, sessionFile: sessionFile ?? null };
    setHasActiveSession(true);
    void loadSessions();
    return true;
  }

  function detachSession() {
    wsSend({ type: 'detach_session' });
    pendingSessionRef.current = null;
    activeRpcSessionRef.current = null;
    setHasActiveSession(false);
    setIsStreaming(false);
    setSessionStats(null);
    void loadSessions();
  }

  function requestModels(): boolean {
    const sentModels = wsSend({
      type: 'rpc_command',
      command: { type: 'get_available_models', id: 'get_models' },
    });
    const sentState = wsSend({
      type: 'rpc_command',
      command: { type: 'get_state', id: 'get_state' },
    });
    return sentModels && sentState;
  }

  function requestStats() {
    wsSend({
      type: 'rpc_command',
      command: { type: 'get_session_stats', id: 'get_session_stats' },
    });
  }

  function scheduleRequestModels(delayMs = 800) {
    if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
    modelsRetryRef.current = window.setTimeout(() => {
      const sent = requestModels();
      if (!sent) scheduleRequestModels(delayMs);
    }, delayMs);
  }

  async function loadSessions() {
    try {
      const res = await fetch('/api/sessions');
      setSessions((await res.json()) as SessionSummary[]);
    } catch {
    } finally {
      setHasLoadedSessions(true);
    }
  }

  useEffect(() => {
    if (!isProjectsView) return;

    const controller = new AbortController();
    const query = folderBrowserCwd ? `?cwd=${encodeURIComponent(folderBrowserCwd)}` : '';

    setIsFolderBrowserLoading(true);
    setFolderBrowserError(null);

    fetch(`/api/folders${query}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('failed to load folders');
        return (await res.json()) as {
          cwd: string;
          root: string;
          folders: FolderEntry[];
          error?: string;
        };
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setFolderBrowserCwd(data.cwd);
        setFolderBrowserRoot(data.root);
        setFolderEntries(Array.isArray(data.folders) ? data.folders : []);
        setFolderBrowserError(data.error ?? null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFolderEntries([]);
        setFolderBrowserError('unable to load folders');
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setIsFolderBrowserLoading(false);
      });

    return () => controller.abort();
  }, [folderBrowserCwd, isProjectsView]);

  useEffect(() => {
    if (!isHistoryView || !selectedProjectCwd || !activeSessionFile || isNewSessionRoute) {
      if (externalSessionSyncTimerRef.current)
        window.clearInterval(externalSessionSyncTimerRef.current);
      externalSessionSyncTimerRef.current = null;
      externalSessionSyncAbortRef.current?.abort();
      externalSessionSyncAbortRef.current = null;
      externalSessionSyncInFlightRef.current = false;
      return;
    }

    let cancelled = false;

    const poll = async () => {
      if (cancelled || externalSessionSyncInFlightRef.current) return;

      const isActiveStreamForCurrentSession =
        isStreamingRef.current &&
        activeRpcSessionRef.current?.cwd === selectedProjectCwd &&
        activeRpcSessionRef.current?.sessionFile === activeSessionFile;
      if (isActiveStreamForCurrentSession) return;

      externalSessionSyncInFlightRef.current = true;
      const controller = new AbortController();
      externalSessionSyncAbortRef.current = controller;

      try {
        await syncSessionMessagesFromDisk(selectedProjectCwd, activeSessionFile, controller.signal);
      } catch {}
      finally {
        if (externalSessionSyncAbortRef.current === controller) externalSessionSyncAbortRef.current = null;
        externalSessionSyncInFlightRef.current = false;
      }
    };

    void poll();
    externalSessionSyncTimerRef.current = window.setInterval(() => {
      void poll();
    }, EXTERNAL_SESSION_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (externalSessionSyncTimerRef.current)
        window.clearInterval(externalSessionSyncTimerRef.current);
      externalSessionSyncTimerRef.current = null;
      externalSessionSyncAbortRef.current?.abort();
      externalSessionSyncAbortRef.current = null;
      externalSessionSyncInFlightRef.current = false;
    };
  }, [activeSessionFile, isHistoryView, isNewSessionRoute, selectedProjectCwd]);

  function parseContentIntoParts(content: any, parts: MessagePart[]) {
    if (typeof content === 'string') {
      parts.push({ type: 'text', content, done: true });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push({ type: 'text', content: block.text, done: true });
      } else if (block.type === 'thinking' && block.thinking) {
        parts.push({ type: 'thinking', content: block.thinking, done: true });
      } else if (
        block.type === 'toolCall' ||
        block.type === 'tool_call' ||
        block.type === 'tool_use'
      ) {
        const hasResultPayload = block.result !== undefined || block.output !== undefined;
        const envelope = getToolResultEnvelope(block.result ?? block.output ?? '');
        const resultRecord = asRecord(block.result);
        parts.push({
          type: 'tool',
          name: block.name || block.toolName || 'tool',
          args: block.args || block.arguments || block.input,
          content: envelope.text,
          details: envelope.details,
          done: hasResultPayload,
          id: block.id,
          isError: Boolean(block.isError ?? resultRecord?.isError),
        });
      }
    }
  }

  function parseLoadedMessages(messages: ParsedMessage[]): MessageEntry[] {
    return messages.map((msg) => {
      const parts: MessagePart[] = [];
      if (msg.content) parseContentIntoParts(msg.content, parts);
      const ts = msg.timestamp ? Number(msg.timestamp) : undefined;
      return {
        id: msg.id || crypto.randomUUID(),
        role: msg.role || 'unknown',
        parts,
        model: msg.model,
        provider: msg.provider,
        timestamp: Number.isFinite(ts) ? ts : undefined,
        usage: msg.usage,
      };
    });
  }

  function buildMessageSnapshotSignature(messages: MessageEntry[]): string {
    if (messages.length === 0) return '0';

    let totalParts = 0;
    let totalTextLength = 0;
    let toolCount = 0;

    for (const msg of messages) {
      totalParts += msg.parts.length;
      for (const part of msg.parts) {
        if (typeof part.content === 'string') totalTextLength += part.content.length;
        if (part.type === 'tool') toolCount++;
      }
    }

    const last = messages[messages.length - 1];
    const lastPartsSignature = last.parts
      .map(
        (part) =>
          `${part.type}:${part.done ? 1 : 0}:${part.name || ''}:${typeof part.content === 'string' ? part.content.length : 0}`,
      )
      .join('|');

    return [
      messages.length,
      totalParts,
      totalTextLength,
      toolCount,
      last.role,
      last.timestamp ?? '',
      lastPartsSignature,
    ].join('::');
  }

  function getStreamingTarget(
    prev: MessageEntry[],
  ): { target: MessageEntry; index: number } | null {
    if (prev.length === 0) return null;

    if (streamingMessageIdRef.current) {
      const index = prev.findIndex((m) => m.id === streamingMessageIdRef.current);
      if (index < 0) return null;
      return { target: prev[index], index };
    }

    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i].role === 'assistant') return { target: prev[i], index: i };
    }

    return null;
  }

  function handleRpcEvent(event: any) {
    if (!event?.type) return;

    switch (event.type) {
      case 'response': {
        if (event.command === 'get_available_models') {
          const models: Model[] = (event.data?.models ?? []).map((m: any) => ({
            id: m.id,
            name: m.name,
            provider: m.provider,
            contextWindow: m.contextWindow,
            reasoning: m.reasoning,
          }));
          if (models.length > 0) {
            setAvailableModels(models);
            availableModelsRef.current = models;
            if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
            if (!currentModelRef.current) scheduleRequestModels();
          } else {
            scheduleRequestModels();
          }
          requestStats();
        }
        if (event.command === 'get_state') {
          const state = event.data ?? {};
          const model = state.model;
          if (model) {
            const m = {
              id: model.id,
              name: model.name,
              provider: model.provider,
              contextWindow: model.contextWindow,
              reasoning: model.reasoning,
            };
            setCurrentModel(m);
            currentModelRef.current = m;
            setSelectedProvider(model.provider);
            if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
            if (availableModelsRef.current.length === 0) scheduleRequestModels();
          } else {
            scheduleRequestModels();
          }

          const stateThinkingLevel = normaliseThinkingLevel(state.thinkingLevel);
          if (stateThinkingLevel) setThinkingLevel(stateThinkingLevel);

          const requestId = typeof event.id === 'string' ? event.id : '';
          const syncRequest = requestId
            ? sessionRouteSyncAttemptsRef.current.get(requestId)
            : undefined;
          if (syncRequest) {
            sessionRouteSyncAttemptsRef.current.delete(requestId);
            const sessionFile =
              typeof state.sessionFile === 'string'
                ? (state.sessionFile.split('/').pop() ?? '')
                : '';
            const messageCount = typeof state.messageCount === 'number' ? state.messageCount : 0;
            if (
              sessionFile &&
              messageCount > 0 &&
              isNewSessionRouteRef.current &&
              selectedProjectCwdRef.current === syncRequest.cwd
            ) {
              setSessions((prev) => {
                if (prev.some((session) => session.file === sessionFile)) return prev;
                const sessionId =
                  typeof state.sessionId === 'string' && state.sessionId
                    ? state.sessionId
                    : sessionFile;
                return [
                  {
                    id: sessionId,
                    file: sessionFile,
                    cwd: syncRequest.cwd,
                    timestamp: new Date().toISOString(),
                    messageCount: Math.max(messageCount, 1),
                  },
                  ...prev,
                ];
              });
              syncNavigatedRef.current = true;
              navigate(sessionRoutePath(syncRequest.cwd, sessionFile), { replace: true });
            } else if (
              syncRequest.attemptsLeft > 0 &&
              isNewSessionRouteRef.current &&
              selectedProjectCwdRef.current === syncRequest.cwd
            ) {
              window.setTimeout(() => {
                if (!isNewSessionRouteRef.current) return;
                if (selectedProjectCwdRef.current !== syncRequest.cwd) return;
                requestSessionRouteSync(syncRequest.cwd, syncRequest.attemptsLeft - 1);
              }, 250);
            }
          }
        }
        if (event.command === 'set_model' && event.success) {
          const model = event.data;
          if (model) {
            const m = {
              id: model.id,
              name: model.name,
              provider: model.provider,
              contextWindow: model.contextWindow,
              reasoning: model.reasoning,
            };
            setCurrentModel(m);
            currentModelRef.current = m;
          }
          wsSend({ type: 'rpc_command', command: { type: 'get_state', id: 'get_state' } });
        }
        if (event.command === 'set_thinking_level' && event.success) {
          const level = normaliseThinkingLevel(event.data?.level);
          if (level) setThinkingLevel(level);
          wsSend({ type: 'rpc_command', command: { type: 'get_state', id: 'get_state' } });
        }
        if (event.command === 'cycle_thinking_level' && event.success) {
          const level = normaliseThinkingLevel(event.data?.level);
          if (level) setThinkingLevel(level);
          wsSend({ type: 'rpc_command', command: { type: 'get_state', id: 'get_state' } });
        }
        if (event.command === 'get_session_stats' && event.success) {
          setSessionStats(event.data);
        }
        break;
      }

      case 'agent_start':
        setIsStreaming(true);
        void loadSessions();
        break;

      case 'agent_end':
        setIsStreaming(false);
        streamingMessageIdRef.current = null;
        loadSessions();
        requestStats();
        if (availableModelsRef.current.length === 0 || !currentModelRef.current)
          scheduleRequestModels();
        setPromptQueue((q) => {
          if (q.length === 0) return q;
          const [next, ...rest] = q;
          wsSend({
            type: 'rpc_command',
            command: { type: 'prompt', message: next, id: `web-${Date.now()}` },
          });
          return rest;
        });
        break;

      case 'message_start': {
        const msg = event.message;
        if (!msg) break;
        const id = msg.id || crypto.randomUUID();
        const role = msg.role || 'assistant';
        if (role === 'toolResult' || role === 'tool_result' || role === 'tool') break;
        const parts: MessagePart[] = [];
        if (msg.content) parseContentIntoParts(msg.content, parts);
        const entry: MessageEntry = {
          id,
          role,
          parts,
          model: msg.model,
          provider: msg.provider,
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
          usage: msg.usage,
        };
        if (role === 'assistant') streamingMessageIdRef.current = id;
        setCurrentMessages((prev) => {
          if (prev.some((m) => m.id === id)) return prev;
          return [...prev, entry];
        });
        break;
      }

      case 'message_update': {
        const ame = event.assistantMessageEvent;
        const isThinking = ame?.type === 'thinking_delta';
        const delta: string | undefined =
          ame?.type === 'text_delta' || ame?.type === 'thinking_delta' ? ame.delta : undefined;
        if (!delta) break;
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const parts = [...hit.target.parts];
          const partType = isThinking ? 'thinking' : 'text';
          let part = parts.find((p) => p.type === partType && !p.done);
          if (!part) {
            part = { type: partType, content: '' };
            parts.push(part);
          }
          part.content = `${part.content || ''}${delta}`;
          const next = [...prev];
          next[hit.index] = { ...hit.target, parts };
          return next;
        });
        break;
      }

      case 'message_end': {
        const m = event.message;
        if (m?.role && m.role !== 'assistant') break;
        const endTs = typeof m?.timestamp === 'number' ? m.timestamp : undefined;
        const streamId = streamingMessageIdRef.current;
        setCurrentMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== streamId) return msg;
            const ts = endTs ?? msg.timestamp;
            if (m?.content) {
              const parts: MessagePart[] = [];
              parseContentIntoParts(m.content, parts);
              return {
                ...msg,
                parts,
                model: m.model ?? msg.model,
                provider: m.provider ?? msg.provider,
                timestamp: ts,
                usage: m.usage ?? msg.usage,
              };
            }
            return {
              ...msg,
              parts: msg.parts.map((p) => ({ ...p, done: true })),
              timestamp: ts,
              usage: m?.usage ?? msg.usage,
            };
          }),
        );
        break;
      }

      case 'tool_execution_start': {
        const toolCallId = event.toolCallId || event.id;
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const parts = [...hit.target.parts];
          const existingIndex = parts.findIndex(
            (part) => part.type === 'tool' && part.id && toolCallId && part.id === toolCallId,
          );

          if (existingIndex >= 0) {
            const existing = parts[existingIndex];
            parts[existingIndex] = {
              ...existing,
              type: 'tool',
              name: event.toolName || event.name || existing.name || 'tool',
              args: event.args ?? existing.args,
              content: existing.content ?? '',
              done: false,
              id: toolCallId,
              details: existing.details,
              isError: false,
            };
          } else {
            parts.push({
              type: 'tool',
              name: event.toolName || event.name || 'tool',
              args: event.args,
              content: '',
              done: false,
              id: toolCallId,
              isError: false,
            });
          }

          const next = [...prev];
          next[hit.index] = { ...hit.target, parts };
          return next;
        });
        break;
      }

      case 'tool_execution_update': {
        const toolCallId = event.toolCallId || event.id;
        const hasPartialResult = event.partialResult !== undefined;
        const partialEnvelope = hasPartialResult
          ? getToolResultEnvelope(event.partialResult)
          : getToolResultEnvelope(event.output);
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const parts = [...hit.target.parts];
          const rev = [...parts].reverse();
          const tool =
            rev.find((p) => p.type === 'tool' && !p.done && (!toolCallId || p.id === toolCallId)) ||
            rev.find((p) => p.type === 'tool' && !p.done);
          if (tool) {
            if (event.args !== undefined) tool.args = event.args;
            if (hasPartialResult) {
              tool.content = partialEnvelope.text;
            } else if (partialEnvelope.text) {
              tool.content = `${extractToolText(tool.content)}${partialEnvelope.text}`;
            }
            if (partialEnvelope.details !== undefined) tool.details = partialEnvelope.details;
          }
          const next = [...prev];
          next[hit.index] = { ...hit.target, parts };
          return next;
        });
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId || event.id;
        const finalEnvelope = getToolResultEnvelope(event.result ?? event.output ?? '');
        const shouldReplaceContent = event.result !== undefined || event.output !== undefined;
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const parts = [...hit.target.parts];
          const rev = [...parts].reverse();
          const tool =
            rev.find((p) => p.type === 'tool' && !p.done && (!toolCallId || p.id === toolCallId)) ||
            rev.find((p) => p.type === 'tool' && !p.done);
          if (tool) {
            if (event.args !== undefined) tool.args = event.args;
            tool.done = true;
            tool.isError = Boolean(event.isError);
            if (shouldReplaceContent) tool.content = finalEnvelope.text;
            if (finalEnvelope.details !== undefined) tool.details = finalEnvelope.details;
          }
          const next = [...prev];
          next[hit.index] = { ...hit.target, parts };
          return next;
        });
        break;
      }

      case 'model_changed': {
        const model = event.model;
        if (model) {
          const m = {
            id: model.id,
            name: model.name,
            provider: model.provider,
            contextWindow: model.contextWindow,
            reasoning: model.reasoning,
          };
          setCurrentModel(m);
          currentModelRef.current = m;
        }
        const level = normaliseThinkingLevel(event.thinkingLevel ?? event.level);
        if (level) setThinkingLevel(level);
        break;
      }
    }
  }

  async function hydrateSessionMessages(cwd: string, file: string) {
    try {
      const res = await fetch(
        `/api/session?cwd=${encodeURIComponent(cwd)}&filename=${encodeURIComponent(file)}`,
      );
      if (!res.ok) return;
      const messages = (await res.json()) as ParsedMessage[];
      const parsed = parseLoadedMessages(messages);
      lastExternalSessionSignatureRef.current = buildMessageSnapshotSignature(parsed);
      setCurrentMessages(parsed);
    } catch {}
  }

  async function syncSessionMessagesFromDisk(cwd: string, file: string, signal: AbortSignal) {
    const res = await fetch(
      `/api/session?cwd=${encodeURIComponent(cwd)}&filename=${encodeURIComponent(file)}`,
      { signal },
    );
    if (!res.ok) return;

    const messages = (await res.json()) as ParsedMessage[];
    const parsed = parseLoadedMessages(messages);
    const signature = buildMessageSnapshotSignature(parsed);
    if (signature === lastExternalSessionSignatureRef.current) return;

    lastExternalSessionSignatureRef.current = signature;
    setCurrentMessages(parsed);
    void loadSessions();
  }

  function resetSessionViewState() {
    setCurrentMessages([]);
    setInputValue('');
    streamingMessageIdRef.current = null;
    setIsStreaming(false);
    setSessionStats(null);
    lastExternalSessionSignatureRef.current = null;
    if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
  }

  async function activateExistingSession(cwd: string, file: string) {
    if (
      hasActiveSessionRef.current &&
      activeRpcSessionRef.current?.sessionFile === file &&
      activeRpcSessionRef.current?.cwd === cwd
    ) {
      inputRef.current?.focus();
      return;
    }

    resetSessionViewState();
    await hydrateSessionMessages(cwd, file);

    if (startSession(cwd, file)) {
      scheduleRequestModels(120);
      requestStats();
    }
    inputRef.current?.focus();
  }

  function activateNewSession(cwd: string) {
    if (
      hasActiveSessionRef.current &&
      activeRpcSessionRef.current?.sessionFile === null &&
      activeRpcSessionRef.current?.cwd === cwd
    ) {
      inputRef.current?.focus();
      return;
    }

    resetSessionViewState();
    if (startSession(cwd, null)) {
      scheduleRequestModels(120);
      requestStats();
    }
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (!selectedProjectCwd || sessionIdParam == null) return;

    if (isNewSessionRoute) {
      activateNewSession(selectedProjectCwd);
      return;
    }

    if (!activeSessionFile) return;
    const exists = sessions.some(
      (session) => session.cwd === selectedProjectCwd && session.file === activeSessionFile,
    );
    if (!exists) return;
    if (syncNavigatedRef.current) {
      syncNavigatedRef.current = false;
      activeRpcSessionRef.current = { cwd: selectedProjectCwd, sessionFile: activeSessionFile };
      return;
    }
    void activateExistingSession(selectedProjectCwd, activeSessionFile);
  }, [activeSessionFile, isNewSessionRoute, selectedProjectCwd, sessionIdParam, sessions]);

  function switchSession(file: string) {
    const cwd = sessionsRef.current.find((s) => s.file === file)?.cwd;
    if (!cwd) return;
    navigate(sessionRoutePath(cwd, file));
  }

  function newSessionInFolder(cwd: string) {
    navigate(newSessionRoutePath(cwd));
  }

  function handleSelectProject(cwd: string) {
    navigate(projectRoutePath(cwd));
  }

  function browseIntoFolder(path: string) {
    navigate(projectsRoutePath(path));
  }

  function browseToParentFolder() {
    if (!folderBrowserCwd || !folderBrowserRoot || folderBrowserCwd === folderBrowserRoot) return;
    const parts = folderBrowserCwd.split('/').filter(Boolean);
    const parent = parts.length <= 1 ? '/' : `/${parts.slice(0, -1).join('/')}`;
    navigate(projectsRoutePath(parent));
  }

  function openCurrentFolder() {
    if (!folderBrowserCwd) return;
    handleSelectProject(folderBrowserCwd);
  }

  function goBackToProjects() {
    navigate(projectsRoutePath(selectedProjectCwd ?? folderBrowserCwd));
  }

  function goBackToSessions() {
    if (!selectedProjectCwd) {
      navigate(projectsRoutePath(folderBrowserCwd));
      return;
    }
    navigate(projectRoutePath(selectedProjectCwd));
  }

  function sendPrompt() {
    const text = inputValue.trim();
    if (!text || !isConnected || !hasActiveSession) return;
    setInputValue('');
    if (isStreaming) {
      setPromptQueue((q) => [...q, text]);
      return;
    }
    const sent = wsSend({
      type: 'rpc_command',
      command: { type: 'prompt', message: text, id: `web-${Date.now()}` },
    });
    if (sent && isNewSessionRoute && selectedProjectCwd) {
      requestSessionRouteSync(selectedProjectCwd);
    }
  }

  function sendAbort() {
    wsSend({ type: 'rpc_command', command: { type: 'abort', id: `abort-${Date.now()}` } });
  }

  function handleProviderChange(provider: string) {
    setSelectedProvider(provider);
  }

  function handleModelChange(modelId: string) {
    const model = availableModels.find((m) => m.id === modelId && m.provider === selectedProvider);
    if (!model) return;
    wsSend({
      type: 'rpc_command',
      command: { type: 'set_model', provider: model.provider, modelId: model.id, id: 'set_model' },
    });
  }

  function handleThinkingLevelChange(level: string) {
    const nextLevel = normaliseThinkingLevel(level);
    if (!nextLevel) return;
    setThinkingLevel(nextLevel);
    wsSend({
      type: 'rpc_command',
      command: { type: 'set_thinking_level', level: nextLevel, id: 'set_thinking_level' },
    });
  }

  async function deleteSession(file: string) {
    const cwd = sessionsRef.current.find((s) => s.file === file)?.cwd ?? selectedProjectCwd ?? '';
    try {
      await fetch(
        `/api/session?cwd=${encodeURIComponent(cwd)}&filename=${encodeURIComponent(file)}`,
        { method: 'DELETE' },
      );
    } catch {}
    setSessions((prev) => prev.filter((s) => s.file !== file));
    const activeCwd = selectedProjectCwd ?? sessionsRef.current.find((s) => s.file === file)?.cwd;
    if (activeSessionFileRef.current === file) {
      setCurrentMessages([]);
      setInputValue('');
      streamingMessageIdRef.current = null;
      setIsStreaming(false);
      setHasActiveSession(false);
      setSessionStats(null);
      if (activeCwd) {
        navigate(projectRoutePath(activeCwd));
      } else {
        navigate('/');
      }
    }
  }

  const connectionA11yLabel = isStreaming ? 'streaming response' : 'session status';

  return (
    <div className="flex flex-col h-full bg-pi-page-bg text-gray-900 text-sm font-mono overflow-hidden">
      {isProjectsView && (
        <main className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
          <FolderBrowser
            cwd={folderBrowserCwd}
            folders={folderEntries}
            isLoading={isFolderBrowserLoading}
            error={folderBrowserError}
            canNavigateUp={canNavigateFolderUp}
            onBrowseIntoFolder={browseIntoFolder}
            onBrowseToParent={browseToParentFolder}
            onOpenCurrentFolder={openCurrentFolder}
          />
        </main>
      )}

      {isSessionsView && selectedProjectCwd && (
        <main className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
          <SessionPicker
            projectCwd={selectedProjectCwd}
            sessions={sessionsForSelectedProject}
            onBack={goBackToProjects}
            onCreateSession={() => newSessionInFolder(selectedProjectCwd)}
            onSelectSession={switchSession}
            onDeleteSession={deleteSession}
          />
        </main>
      )}

      {isSessionsView && !selectedProjectCwd && (
        <main className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
          <div className="mx-auto max-w-3xl rounded-xl border border-pi-border-muted bg-pi-card-bg p-4">
            <div className="text-sm text-pi-muted mb-3">no folder selected</div>
            <button
              onClick={goBackToProjects}
              className="px-3 py-1.5 rounded-lg border border-pi-border-muted text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer"
            >
              choose folder
            </button>
          </div>
        </main>
      )}

      {isHistoryView && (
        <main className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-4 py-2 md:px-6 border-b border-pi-border-muted bg-pi-card-bg">
            <div className="min-w-0">
              <div className="text-[11px] text-pi-dim truncate">
                {selectedProjectCwd ? shortenCwd(selectedProjectCwd) : 'folder not selected'}
              </div>
              <div className="text-xs truncate text-pi-muted">
                {activeSessionFile ? activeSessionFile.split('/').pop() : 'new session'}
              </div>
            </div>
            <button
              onClick={goBackToSessions}
              title="back to sessions"
              className="ml-auto inline-flex items-center justify-center h-10 w-10 shrink-0 aspect-square rounded-lg border border-pi-border-muted text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="10.5,3 5,8 10.5,13" />
              </svg>
            </button>
          </div>

          <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-2 md:px-6">
            {currentMessages.length === 0 ? (
              <div className="flex items-center justify-center h-full text-pi-muted text-base">
                choose a session and start prompting.
              </div>
            ) : (
              currentMessages
                .filter(
                  (msg) =>
                    (msg.role === 'user' || msg.role === 'assistant') &&
                    (msg.role === 'user' ||
                      msg.parts.some(
                        (p) => p.type === 'tool' || (p.type === 'text' && (p.content ?? '').trim()),
                      )),
                )
                .map((msg) => <MessageBubble key={msg.id} msg={msg} />)
            )}
          </div>

          <div className="flex items-center gap-3 px-4 py-1.5 md:px-6 border-t border-pi-border-muted bg-pi-card-bg text-xs text-pi-muted flex-wrap">
            {availableModels.length > 0 && (
              <span className="flex items-center gap-1.5">
                <select
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={isStreaming}
                  className="font-mono text-gray-700 bg-white border border-pi-border-muted rounded px-1 py-0.5 cursor-pointer disabled:opacity-50 select-fit-content"
                >
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedModelId}
                  onChange={(e) => handleModelChange(e.target.value)}
                  disabled={isStreaming}
                  className="font-mono text-gray-700 bg-white border border-pi-border-muted rounded px-1 py-0.5 cursor-pointer disabled:opacity-50 select-fit-content"
                >
                  {modelsForProvider.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
              </span>
            )}
            {availableModels.length === 0 && currentModel && <span>{currentModel.id}</span>}
            {hasActiveSession && (availableModels.length > 0 || currentModel) && (
              <select
                value={thinkingLevel}
                onChange={(e) => handleThinkingLevelChange(e.target.value)}
                disabled={!isConnected || isStreaming || currentModel?.reasoning === false}
                aria-label="thinking level"
                title="thinking level"
                className="font-mono text-gray-700 bg-white border border-pi-border-muted rounded px-1 py-0.5 cursor-pointer disabled:opacity-50 select-fit-content"
              >
                {thinkingLevelOptions.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            )}
            {sessionStats && (
              <span className="flex items-center gap-2 text-pi-dim ml-auto flex-wrap">
                {sessionStats.tokens.input > 0 && (
                  <span>↑{formatTokens(sessionStats.tokens.input)}</span>
                )}
                {sessionStats.tokens.output > 0 && (
                  <span>↓{formatTokens(sessionStats.tokens.output)}</span>
                )}
                {sessionStats.tokens.cacheRead > 0 && (
                  <span>r{formatTokens(sessionStats.tokens.cacheRead)}</span>
                )}
                {sessionStats.tokens.cacheWrite > 0 && (
                  <span>w{formatTokens(sessionStats.tokens.cacheWrite)}</span>
                )}
                {sessionStats.cost > 0 && <span>${sessionStats.cost.toFixed(3)}</span>}
                {currentModel?.contextWindow &&
                  contextUsageTokens &&
                  (() => {
                    const pct = (contextUsageTokens / currentModel.contextWindow!) * 100;
                    const color = pct > 90 ? 'text-pi-error' : pct > 70 ? 'text-pi-warning' : '';
                    return (
                      <span className={color}>
                        {pct.toFixed(1)}%/{formatTokens(currentModel.contextWindow!)}
                      </span>
                    );
                  })()}
              </span>
            )}
            {isStreaming && (
              <span>
                responding{promptQueue.length > 0 ? ` · ${promptQueue.length} queued` : ''}
              </span>
            )}
          </div>

          <div className="px-4 pb-4 pt-3 md:px-6 border-t border-pi-border-muted bg-pi-card-bg">
            <div className="flex gap-2 items-center">
              <span className="sr-only" aria-live="polite">
                {connectionA11yLabel}
              </span>
              <textarea
                ref={inputRef}
                rows={1}
                placeholder={hasActiveSession ? 'send a message...' : 'create or select a session'}
                disabled={!hasActiveSession}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendPrompt();
                  }
                }}
                className="prompt-input flex-1 bg-white border border-pi-border-muted rounded-lg px-3 py-2.5 font-mono resize-none min-h-[42px] max-h-[200px] outline-none focus:border-pi-accent disabled:opacity-50 disabled:cursor-default"
              />
              <div className="flex flex-row gap-1 flex-shrink-0">
                <button
                  onClick={sendPrompt}
                  disabled={!isConnected || !hasActiveSession}
                  title={isStreaming ? 'queue message' : 'send'}
                  aria-label={isStreaming ? 'queue message' : 'send message'}
                  className="relative h-[42px] aspect-square inline-flex items-center justify-center flex-shrink-0 rounded-lg bg-pi-accent text-white cursor-pointer hover:opacity-90 disabled:opacity-40 disabled:cursor-default disabled:bg-pi-border-muted"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="2" y1="9" x2="16" y2="9" />
                    <polyline points="10,3 16,9 10,15" />
                  </svg>
                  {promptQueue.length > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-pi-warning text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center leading-none">
                      {promptQueue.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={sendAbort}
                  disabled={!isStreaming || !hasActiveSession}
                  title="stop"
                  className="h-[42px] aspect-square inline-flex items-center justify-center flex-shrink-0 rounded-lg border border-pi-border-muted text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer disabled:opacity-40 disabled:cursor-default"
                >
                  <svg width="20" height="20" viewBox="0 0 18 18" fill="currentColor">
                    <rect x="4" y="4" width="10" height="10" rx="1.5" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: MessageEntry }) {
  const isUser = msg.role === 'user';
  const hasVisibleTextPart = msg.parts.some(
    (part) => part.type === 'text' && Boolean((part.content ?? '').trim()),
  );
  const hasToolPart = msg.parts.some((part) => part.type === 'tool');
  const isToolOnlyMessage = !isUser && hasToolPart && !hasVisibleTextPart;

  return (
    <div className="mb-2 min-w-0">
      <div
        className={`rounded-lg ${isToolOnlyMessage ? 'p-0' : 'px-2 py-1.5'} min-w-0 overflow-hidden ${isUser ? 'bg-pi-user-bg' : 'bg-pi-card-bg border border-pi-border-muted'}`}
      >
        <div className="text-xs md:text-sm leading-relaxed break-words min-w-0">
          {msg.parts.map((part, index) => (
            <Part key={`${msg.id}-${index}`} part={part} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FolderBrowser({
  cwd,
  folders,
  isLoading,
  error,
  canNavigateUp,
  onBrowseIntoFolder,
  onBrowseToParent,
  onOpenCurrentFolder,
}: {
  cwd: string | null;
  folders: FolderEntry[];
  isLoading: boolean;
  error: string | null;
  canNavigateUp: boolean;
  onBrowseIntoFolder: (path: string) => void;
  onBrowseToParent: () => void;
  onOpenCurrentFolder: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base md:text-lg font-semibold text-pi-accent">browse folders</h1>
          <p className="text-pi-muted mt-1 truncate" title={cwd ?? ''}>
            {cwd ? asHomeRelativePath(cwd) : 'loading…'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onOpenCurrentFolder}
            disabled={!cwd}
            title="open current folder"
            aria-label="open current folder"
            className="inline-flex items-center justify-center h-10 w-10 shrink-0 aspect-square rounded-lg border border-pi-border-muted text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1.5 6.1V4.8a1 1 0 0 1 1-1h3l1.3 1.3h6.7a1 1 0 0 1 1 1v.8" />
              <path d="M1.5 6.9h13l-1.2 5.2a1 1 0 0 1-1 .8H3.7a1 1 0 0 1-1-.8L1.5 6.9Z" />
            </svg>
          </button>
          <button
            onClick={onBrowseToParent}
            disabled={!canNavigateUp}
            title="back"
            className="inline-flex items-center justify-center h-10 w-10 shrink-0 aspect-square rounded-lg border border-pi-border-muted text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="10.5,3 5,8 10.5,13" />
            </svg>
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-pi-border-muted bg-pi-card-bg">
        {isLoading && (
          <div className="px-4 py-6 text-center text-pi-muted">loading folders…</div>
        )}

        {!isLoading && error && (
          <div className="px-4 py-6 text-center text-pi-error">{error}</div>
        )}

        {!isLoading && !error && folders.length === 0 && (
          <div className="px-4 py-6 text-center text-pi-muted">no visible folders here.</div>
        )}

        {!isLoading && !error && folders.length > 0 && (
          <div className="divide-y divide-pi-border-muted">
            {folders.map((folder) => (
              <button
                key={folder.path}
                onClick={() => onBrowseIntoFolder(folder.path)}
                className="w-full text-left px-4 py-3 hover:bg-pi-user-bg cursor-pointer"
                title={folder.path}
              >
                <div className="text-sm text-gray-800 truncate">{folder.name}</div>
              </button>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

function SessionPicker({
  projectCwd,
  sessions,
  onBack,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
}: {
  projectCwd: string;
  sessions: SessionSummary[];
  onBack: () => void;
  onCreateSession: () => void;
  onSelectSession: (file: string) => void;
  onDeleteSession: (file: string) => void;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-start gap-3 justify-between">
        <div className="min-w-0">
          <h1 className="text-base md:text-lg font-semibold text-pi-accent">choose a session</h1>
          <p className="text-pi-muted mt-1 truncate" title={projectCwd}>
            {projectCwd}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onCreateSession}
            title="new session"
            className="inline-flex items-center justify-center h-10 w-10 shrink-0 aspect-square rounded-lg border border-pi-border-muted text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
          </button>
          <button
            onClick={onBack}
            title="back to folders"
            className="inline-flex items-center justify-center h-10 w-10 shrink-0 aspect-square rounded-lg border border-pi-border-muted text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="10.5,3 5,8 10.5,13" />
            </svg>
          </button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-pi-border-muted bg-pi-card-bg px-4 py-6 text-center text-pi-muted">
          no sessions in this folder yet.
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const label = session.firstPrompt || session.id.slice(0, 8);
            const time = session.timestamp ? new Date(session.timestamp).toLocaleString() : '';
            const isWorking = Boolean(session.isWorking);
            const isActive = Boolean(session.isActive);
            const statusLabel = isWorking ? 'working' : isActive ? 'active' : 'idle';
            const statusDotClass = isWorking
              ? 'bg-pi-success animate-pulse-dot'
              : isActive
                ? 'bg-pi-accent'
                : 'bg-pi-border-muted';
            return (
              <div
                key={session.file}
                className="group relative w-full text-left rounded-xl border border-pi-border-muted bg-pi-card-bg px-4 py-3 hover:bg-pi-user-bg"
              >
                <button
                  onClick={() => onSelectSession(session.file)}
                  className="w-full text-left cursor-pointer"
                >
                  <div className="text-sm text-gray-800 truncate pr-8">{label}</div>
                  <div className="text-[11px] text-pi-muted mt-1 flex items-center gap-1.5 flex-wrap">
                    <span>{session.messageCount} msgs</span>
                    <span>·</span>
                    <span>{time}</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                      {statusLabel}
                    </span>
                  </div>
                </button>
                <button
                  onClick={() => onDeleteSession(session.file)}
                  title="delete session"
                  className="absolute top-3 right-3 hidden group-hover:inline-flex items-center justify-center w-6 h-6 rounded text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg cursor-pointer"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
                    <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Part({ part }: { part: MessagePart }) {
  if (part.type === 'text') {
    return <div dangerouslySetInnerHTML={{ __html: formatText(part.content || '') }} />;
  }
  if (part.type === 'thinking') {
    return null;
  }
  if (part.type === 'tool') {
    return <ToolPart part={part} />;
  }
  return null;
}

function ToolPart({ part }: { part: MessagePart }) {
  const body = useMemo(() => formatToolExecutionForDisplay(part), [part]);
  const preMaxHeightClass = part.name === 'edit' ? '' : 'max-h-64';
  const preOverflowClass = part.name === 'edit' ? 'overflow-x-auto' : 'overflow-auto';

  return (
    <div
      className={`my-0 px-1.5 py-1 text-xs overflow-hidden ${
        part.done ? (part.isError ? 'bg-pi-tool-error' : 'bg-pi-tool-success') : 'bg-pi-tool-pending'
      }`}
    >
      <pre
        className={`tool-io-pre ${preMaxHeightClass} ${preOverflowClass} ${part.isError ? 'text-pi-error' : 'text-pi-tool-output'}`}
      >
        {body}
      </pre>
    </div>
  );
}

function formatText(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(escapeHtml(lines[i]));
        i++;
      }
      out.push(
        `<pre class="bg-pi-page-bg border border-pi-border-muted rounded-lg p-3 overflow-x-auto my-2 text-xs font-mono text-pi-md-code-block"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${code.join('\n')}</code></pre>`,
      );
      i++;
      continue;
    }

    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
      const headers = parseTableRow(lines[i]);
      const aligns = parseTableAligns(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      const ths = headers
        .map(
          (h, ci) =>
            `<th class="border border-pi-border-muted px-3 py-1.5 bg-pi-page-bg font-semibold text-left" style="${alignStyle(aligns[ci])}">${inlineFormat(h)}</th>`,
        )
        .join('');
      const trs = rows
        .map(
          (row) =>
            `<tr>${row.map((cell, ci) => `<td class="border border-pi-border-muted px-3 py-1.5" style="${alignStyle(aligns[ci])}">${inlineFormat(cell)}</td>`).join('')}</tr>`,
        )
        .join('');
      out.push(
        `<div class="overflow-x-auto my-2"><table class="border-collapse text-xs w-full"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`,
      );
      continue;
    }

    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const sizes = ['text-lg', 'text-base', 'text-sm', 'text-sm', 'text-xs', 'text-xs'];
      out.push(
        `<h${level} class="font-semibold ${sizes[level - 1]} mt-3 mb-1 text-pi-md-heading">${inlineFormat(hMatch[2])}</h${level}>`,
      );
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push(`<hr class="border-t border-pi-border-muted my-3">`);
      i++;
      continue;
    }

    if (line.trim() === '') {
      out.push('<br>');
      i++;
      continue;
    }

    out.push(`<span>${inlineFormat(line)}</span><br>`);
    i++;
  }

  return out.join('');
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

function parseTableAligns(sep: string): string[] {
  return sep
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
}

function alignStyle(align: string): string {
  return `text-align:${align}`;
}

function inlineFormat(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(
    /`([^`]+)`/g,
    `<code class="bg-pi-page-bg text-pi-md-code px-1 py-0.5 rounded text-xs font-mono">$1</code>`,
  );
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/~~([^~]+)~~/g, "<del class='opacity-60'>$1</del>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    `<a href="$2" target="_blank" rel="noopener" class="text-pi-md-link underline">$1</a>`,
  );
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function getUsageTokens(usage?: Usage): number {
  if (!usage) return 0;
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens))
    return usage.totalTokens;
  const input = typeof usage.input === 'number' && Number.isFinite(usage.input) ? usage.input : 0;
  const output =
    typeof usage.output === 'number' && Number.isFinite(usage.output) ? usage.output : 0;
  const cacheRead =
    typeof usage.cacheRead === 'number' && Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
  const cacheWrite =
    typeof usage.cacheWrite === 'number' && Number.isFinite(usage.cacheWrite)
      ? usage.cacheWrite
      : 0;
  return input + output + cacheRead + cacheWrite;
}

function estimateMessageTokens(message: MessageEntry): number {
  let chars = 0;
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'thinking') {
      chars += (part.content ?? '').length;
      continue;
    }
    if (part.type === 'tool') {
      chars += (part.name ?? '').length;
      chars += (part.content ?? '').length;
      if (part.args != null) {
        try {
          chars += JSON.stringify(part.args).length;
        } catch {}
      }
    }
  }
  return Math.ceil(chars / 4);
}

function estimateContextTokens(messages: MessageEntry[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const usageTokens = getUsageTokens(message.usage);
    if (usageTokens <= 0) continue;
    let trailing = 0;
    for (let j = i + 1; j < messages.length; j++) trailing += estimateMessageTokens(messages[j]);
    return usageTokens + trailing;
  }
  const estimated = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return estimated > 0 ? estimated : null;
}
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  return `${Math.round(n / 1_000_000)}m`;
}

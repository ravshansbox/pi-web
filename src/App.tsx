import { useEffect, useMemo, useRef, useState } from "react";

type SessionSummary = {
  id: string;
  file: string;
  cwd: string;
  timestamp: string;
  firstPrompt?: string;
  messageCount: number;
};

type MessagePart = {
  type: "text" | "thinking" | "tool";
  content?: string;
  name?: string;
  args?: unknown;
  done?: boolean;
  id?: string;
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

type Folder = {
  cwd: string;
  label: string;
  sessions: SessionSummary[];
};

type Model = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
};

type SessionStats = {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
};

const WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

function shortenCwd(cwd: string): string {
  const home = cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  const parts = home.split("/").filter(Boolean);
  if (parts.length <= 2) return home;
  return "~/../" + parts[parts.length - 1];
}

function groupByFolder(sessions: SessionSummary[]): Folder[] {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const list = map.get(s.cwd) ?? [];
    list.push(s);
    map.set(s.cwd, list);
  }
  return Array.from(map.entries()).map(([cwd, list]) => ({
    cwd,
    label: shortenCwd(cwd),
    sessions: list,
  }));
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionFile, setActiveSessionFile] = useState<string | null>(null);
  const [currentMessages, setCurrentMessages] = useState<MessageEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [hasActiveSession, setHasActiveSession] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [currentModel, setCurrentModel] = useState<Model | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [promptQueue, setPromptQueue] = useState<string[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { activeSessionFileRef.current = activeSessionFile; }, [activeSessionFile]);
  useEffect(() => { hasActiveSessionRef.current = hasActiveSession; }, [hasActiveSession]);
  useEffect(() => { availableModelsRef.current = availableModels; }, [availableModels]);
  useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);

  useEffect(() => {
    connect();
    loadSessions();
    return () => {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!threadRef.current) return;
    requestAnimationFrame(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    });
  }, [currentMessages]);

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = "auto";
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`;
  }, [inputValue]);

  useEffect(() => {
    if (sessions.length === 0) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      const active = activeSessionFileRef.current;
      if (active) {
        const cwd = sessions.find((s) => s.file === active)?.cwd;
        if (cwd) next.add(cwd);
      }
      return next;
    });
  }, [sessions]);

  const providers = useMemo(
    () => Array.from(new Set(availableModels.map((m) => m.provider))),
    [availableModels]
  );

  const modelsForProvider = useMemo(
    () => availableModels.filter((m) => m.provider === selectedProvider),
    [availableModels, selectedProvider]
  );

  const contextUsageTokens = useMemo(() => estimateContextTokens(currentMessages), [currentMessages]);
  function connect() {
    const ws = new WebSocket(WS_BASE);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      if (pendingSessionRef.current) {
        const pending = pendingSessionRef.current;
        pendingSessionRef.current = null;
        wsSend({ type: "start_session", sessionFile: pending.sessionFile ?? undefined, cwd: pending.cwd });
        setHasActiveSession(true);
        scheduleRequestModels();
        requestStats();
        return;
      }
      if (activeSessionFileRef.current || hasActiveSessionRef.current) {
        const file = activeSessionFileRef.current;
        const cwd = file
          ? sessionsRef.current.find((s) => s.file === file)?.cwd
          : sessionsRef.current[0]?.cwd;
        wsSend({ type: "start_session", sessionFile: file ?? undefined, cwd });
        setHasActiveSession(true);
        scheduleRequestModels();
        requestStats();
      }
    };

    ws.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "rpc_event") handleRpcEvent(msg.event);
      if (msg.type === "error") {
        console.error("[pi-web]", msg.message);
        if (typeof msg.message === "string" && msg.message.includes("no active session") && (hasActiveSessionRef.current || pendingSessionRef.current)) {
          scheduleRequestModels(150);
          requestStats();
        }
      }
      if (msg.type === "session_ended") {
        setIsStreaming(false);
        setHasActiveSession(false);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsStreaming(false);
      setHasActiveSession(false);
      pendingSessionRef.current = null;
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

  function startSession(cwd?: string, sessionFile?: string | null): boolean {
    const sent = wsSend({ type: "start_session", sessionFile: sessionFile ?? undefined, cwd });
    if (!sent) {
      pendingSessionRef.current = { cwd, sessionFile };
      setHasActiveSession(false);
      return false;
    }
    pendingSessionRef.current = null;
    setHasActiveSession(true);
    return true;
  }

  function requestModels(): boolean {
    const sentModels = wsSend({ type: "rpc_command", command: { type: "get_available_models", id: "get_models" } });
    const sentState = wsSend({ type: "rpc_command", command: { type: "get_state", id: "get_state" } });
    return sentModels && sentState;
  }

  function requestStats() {
    wsSend({ type: "rpc_command", command: { type: "get_session_stats", id: "get_session_stats" } });
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
      const res = await fetch("/api/sessions");
      setSessions((await res.json()) as SessionSummary[]);
    } catch {}
  }

  function parseContentIntoParts(content: any, parts: MessagePart[]) {
    if (typeof content === "string") {
      parts.push({ type: "text", content, done: true });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push({ type: "text", content: block.text, done: true });
      } else if (block.type === "thinking" && block.thinking) {
        parts.push({ type: "thinking", content: block.thinking, done: true });
      } else if (block.type === "toolCall" || block.type === "tool_call" || block.type === "tool_use") {
        parts.push({
          type: "tool",
          name: block.name || block.toolName || "tool",
          args: block.args || block.arguments || block.input,
          content: block.result ?? block.output ?? "",
          done: true,
          id: block.id,
        });
      }
    }
  }

  function getStreamingTarget(prev: MessageEntry[]): { target: MessageEntry; index: number } | null {
    if (prev.length === 0) return null;
    const index = streamingMessageIdRef.current
      ? prev.findIndex((m) => m.id === streamingMessageIdRef.current)
      : prev.length - 1;
    if (index < 0) return null;
    return { target: prev[index], index };
  }

  function handleRpcEvent(event: any) {
    if (!event?.type) return;

    switch (event.type) {
      case "response": {
        if (event.command === "get_available_models") {
          const models: Model[] = (event.data?.models ?? []).map((m: any) => ({
            id: m.id, name: m.name, provider: m.provider,
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
        if (event.command === "get_state") {
          const model = event.data?.model;
          if (model) {
            const m = { id: model.id, name: model.name, provider: model.provider, contextWindow: model.contextWindow };
            setCurrentModel(m);
            currentModelRef.current = m;
            setSelectedProvider(model.provider);
            if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
            if (availableModelsRef.current.length === 0) scheduleRequestModels();
          } else {
            scheduleRequestModels();
          }
        }
        if (event.command === "set_model" && event.success) {
          const model = event.data;
          if (model) {
            const m = { id: model.id, name: model.name, provider: model.provider, contextWindow: model.contextWindow };
            setCurrentModel(m);
            currentModelRef.current = m;
          }
        }
        if (event.command === "get_session_stats" && event.success) {
          setSessionStats(event.data);
        }
        break;
      }

      case "agent_start":
        setIsStreaming(true);
        break;

      case "agent_end":
        setIsStreaming(false);
        streamingMessageIdRef.current = null;
        loadSessions();
        requestStats();
        if (availableModelsRef.current.length === 0 || !currentModelRef.current) scheduleRequestModels();
        setPromptQueue((q) => {
          if (q.length === 0) return q;
          const [next, ...rest] = q;
          wsSend({ type: "rpc_command", command: { type: "prompt", message: next, id: `web-${Date.now()}` } });
          return rest;
        });
        break;

      case "message_start": {
        const msg = event.message;
        if (!msg) break;
        const id = msg.id || crypto.randomUUID();
        const role = msg.role || "assistant";
        const parts: MessagePart[] = [];
        if (msg.content) parseContentIntoParts(msg.content, parts);
        const entry: MessageEntry = {
          id, role, parts,
          model: msg.model,
          provider: msg.provider,
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
          usage: msg.usage,
        };
        if (role === "assistant") streamingMessageIdRef.current = id;
        setCurrentMessages((prev) => {
          if (prev.some((m) => m.id === id)) return prev;
          return [...prev, entry];
        });
        break;
      }

      case "message_update": {
        const ame = event.assistantMessageEvent;
        const isThinking = ame?.type === "thinking_delta";
        const delta: string | undefined =
          ame?.type === "text_delta" || ame?.type === "thinking_delta" ? ame.delta : undefined;
        if (!delta) break;
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const parts = [...hit.target.parts];
          const partType = isThinking ? "thinking" : "text";
          let part = parts.find((p) => p.type === partType && !p.done);
          if (!part) { part = { type: partType, content: "" }; parts.push(part); }
          part.content = `${part.content || ""}${delta}`;
          const next = [...prev];
          next[hit.index] = { ...hit.target, parts };
          return next;
        });
        break;
      }

      case "message_end": {
        const m = event.message;
        const endTs = typeof m?.timestamp === "number" ? m.timestamp : undefined;
        const streamId = streamingMessageIdRef.current;
        setCurrentMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== streamId) {
              return endTs != null && msg.timestamp == null ? { ...msg, timestamp: endTs } : msg;
            }
            const ts = endTs ?? msg.timestamp;
            if (m?.content) {
              const parts: MessagePart[] = [];
              parseContentIntoParts(m.content, parts);
              return { ...msg, parts, model: m.model ?? msg.model, provider: m.provider ?? msg.provider, timestamp: ts, usage: m.usage ?? msg.usage };
            }
            return { ...msg, parts: msg.parts.map((p) => ({ ...p, done: true })), timestamp: ts, usage: m?.usage ?? msg.usage };
          })
        );
        break;
      }

      case "tool_execution_start": {
        const tool: MessagePart = {
          type: "tool",
          name: event.toolName || event.name || "tool",
          args: event.args,
          content: "",
          done: false,
          id: event.toolCallId || event.id,
        };
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const next = [...prev];
          next[hit.index] = { ...hit.target, parts: [...hit.target.parts, tool] };
          return next;
        });
        break;
      }

      case "tool_execution_update": {
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const parts = [...hit.target.parts];
          const tool = [...parts].reverse().find((p) => p.type === "tool" && !p.done);
          if (tool && event.output) tool.content = `${tool.content || ""}${event.output}`;
          const next = [...prev];
          next[hit.index] = { ...hit.target, parts };
          return next;
        });
        break;
      }

      case "tool_execution_end": {
        const resultText = event.result?.content?.[0]?.text ?? event.output ?? "";
        setCurrentMessages((prev) => {
          const hit = getStreamingTarget(prev);
          if (!hit) return prev;
          const parts = [...hit.target.parts];
          const tool = [...parts].reverse().find(
            (p) => p.type === "tool" && !p.done && (p.id === (event.toolCallId || event.id) || true)
          );
          if (tool) { tool.done = true; tool.content = resultText; }
          const next = [...prev];
          next[hit.index] = { ...hit.target, parts };
          return next;
        });
        break;
      }

      case "model_changed": {
        const model = event.model;
        if (model) {
          const m = { id: model.id, name: model.name, provider: model.provider, contextWindow: model.contextWindow };
          setCurrentModel(m);
          currentModelRef.current = m;
        }
        break;
      }
    }
  }

  async function switchSession(file: string) {
    if (file === activeSessionFileRef.current && hasActiveSessionRef.current) {
      inputRef.current?.focus();
      return;
    }
    setActiveSessionFile(file);
    setCurrentMessages([]);
    setInputValue("");
    streamingMessageIdRef.current = null;
    setIsStreaming(false);
    setSessionStats(null);
    if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
    inputRef.current?.focus();

    try {
      const res = await fetch(`/api/session?file=${encodeURIComponent(file)}`);
      if (res.ok) {
        const messages = (await res.json()) as ParsedMessage[];
        const parsed: MessageEntry[] = messages.map((msg) => {
          const parts: MessagePart[] = [];
          if (msg.content) parseContentIntoParts(msg.content, parts);
          const ts = msg.timestamp ? Number(msg.timestamp) : undefined;
          return {
            id: msg.id || crypto.randomUUID(),
            role: msg.role || "unknown",
            parts,
            model: msg.model,
            provider: msg.provider,
            timestamp: Number.isFinite(ts) ? ts : undefined,
            usage: msg.usage,
          };
        });
        setCurrentMessages(parsed);
      }
    } catch {}

    const cwd = sessionsRef.current.find((s) => s.file === file)?.cwd;
    if (startSession(cwd, file)) {
      scheduleRequestModels(120);
      requestStats();
  }

  }
  function newSessionInFolder(cwd: string) {
    setActiveSessionFile(null);
    setCurrentMessages([]);
    setInputValue("");
    streamingMessageIdRef.current = null;
    setIsStreaming(false);
    setSessionStats(null);
    if (modelsRetryRef.current) window.clearTimeout(modelsRetryRef.current);
    if (startSession(cwd, null)) {
      scheduleRequestModels(120);
      requestStats();
    }
    inputRef.current?.focus();
  }

  function handleNewSession() {
    const defaultCwd = sessionsRef.current[0]?.cwd || "/";
    const cwd = window.prompt("working directory:", defaultCwd);
    if (!cwd) return;
    setExpandedFolders((prev) => new Set([...prev, cwd]));
    newSessionInFolder(cwd);
  }

  function toggleFolder(cwd: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.has(cwd) ? next.delete(cwd) : next.add(cwd);
      return next;
    });
  }

  function ensureSession(): boolean {
    if (hasActiveSessionRef.current) return true;
    if (!isConnected) return false;
    const defaultCwd = sessionsRef.current[0]?.cwd || "/";
    const cwd = window.prompt("working directory:", defaultCwd);
    if (!cwd) return false;
    return startSession(cwd, null);
  }

  function sendPrompt() {
    const text = inputValue.trim();
    if (!text || !isConnected) return;
    setInputValue("");
    if (isStreaming) {
      setPromptQueue((q) => [...q, text]);
      return;
    }
    if (!ensureSession()) return;
    wsSend({ type: "rpc_command", command: { type: "prompt", message: text, id: `web-${Date.now()}` } });
  }

  function sendAbort() {
    wsSend({ type: "rpc_command", command: { type: "abort", id: `abort-${Date.now()}` } });
  }

  function handleProviderChange(provider: string) {
    setSelectedProvider(provider);
  }

  function handleModelChange(modelId: string) {
    const model = availableModels.find((m) => m.id === modelId && m.provider === selectedProvider);
    if (!model) return;
    wsSend({ type: "rpc_command", command: { type: "set_model", provider: model.provider, modelId: model.id, id: "set_model" } });
  }

  async function deleteSession(file: string) {
    try {
      await fetch(`/api/session?file=${encodeURIComponent(file)}`, { method: "DELETE" });
    } catch {}
    setSessions((prev) => prev.filter((s) => s.file !== file));
    if (activeSessionFile === file) {
      setActiveSessionFile(null);
      setCurrentMessages([]);
      setInputValue("");
      streamingMessageIdRef.current = null;
      setIsStreaming(false);
      setHasActiveSession(false);
    }
  }

  const folders = useMemo(() => groupByFolder(sessions), [sessions]);

  const dotClass = isStreaming
    ? "bg-pi-warning animate-pulse-dot"
    : isConnected
      ? "bg-pi-success"
      : "bg-pi-error";

  return (
    <div className="flex flex-col md:flex-row h-full bg-pi-page-bg text-gray-900 text-xs md:text-sm font-mono overflow-hidden">
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      <aside className={`
        md:w-64 md:flex-shrink-0 md:static md:flex md:flex-col
        bg-pi-card-bg border-r border-pi-border-muted
        fixed inset-y-0 left-0 z-30 w-72 flex flex-col
        transition-transform duration-200
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        md:translate-x-0
      `}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-pi-border-muted">
          <h1 className="text-base font-semibold text-pi-accent">pi-web <span className="text-pi-dim font-normal text-xs">v{__APP_VERSION__}</span></h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleNewSession}
              title="new session"
              className="bg-pi-accent text-white p-1.5 rounded-lg hover:opacity-85 cursor-pointer"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" />
              </svg>
            </button>
            <button onClick={() => setSidebarOpen(false)} className="md:hidden text-pi-muted p-1.5 cursor-pointer">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="3" x2="13" y2="13" /><line x1="13" y1="3" x2="3" y2="13" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {folders.map((folder) => (
            <FolderGroup
              key={folder.cwd}
              folder={folder}
              expanded={expandedFolders.has(folder.cwd)}
              activeSessionFile={activeSessionFile}
              onToggle={() => toggleFolder(folder.cwd)}
              onNewSession={() => { setExpandedFolders((p) => new Set([...p, folder.cwd])); newSessionInFolder(folder.cwd); setSidebarOpen(false); }}
              onSelectSession={(file) => { switchSession(file); setSidebarOpen(false); }}
              onDeleteSession={deleteSession}
            />
          ))}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-h-0">
        <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-pi-border-muted bg-pi-card-bg">
          <button onClick={() => setSidebarOpen(true)} className="text-pi-muted p-1 cursor-pointer">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="4" x2="16" y2="4" /><line x1="2" y1="9" x2="16" y2="9" /><line x1="2" y1="14" x2="16" y2="14" />
            </svg>
          </button>
          <span className="text-pi-muted truncate">{activeSessionFile ? activeSessionFile.split("/").pop() : "no session selected"}</span>
        </div>
        <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
          {currentMessages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-pi-muted text-base">
              start a new session or select one from the list.
            </div>
          ) : (
            currentMessages
              .filter((msg) => msg.role === "user" || msg.parts.some((p) => (p.content ?? "").trim() || p.type === "toolCall"))
              .map((msg) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-1.5 border-t border-pi-border-muted bg-pi-card-bg text-xs text-pi-muted flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
            {isStreaming ? "streaming" : isConnected ? "connected" : "disconnected"}
          </span>
          {availableModels.length > 0 && (
            <span className="flex items-center gap-1.5">
              <select
                value={selectedProvider}
                onChange={(e) => handleProviderChange(e.target.value)}
                disabled={isStreaming}
                className="text-xs font-mono text-gray-700 bg-white border border-pi-border-muted rounded px-1 py-0.5 cursor-pointer disabled:opacity-50 max-w-[120px]"
              >
                {providers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select
                value={currentModel?.provider === selectedProvider ? currentModel.id : ""}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={isStreaming}
                className="text-xs font-mono text-gray-700 bg-white border border-pi-border-muted rounded px-1 py-0.5 cursor-pointer disabled:opacity-50 max-w-[160px]"
              >
                {modelsForProvider.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
              </select>
            </span>
          )}
          {availableModels.length === 0 && currentModel && (
            <span>{currentModel.id}</span>
          )}
          {sessionStats && (
            <span className="flex items-center gap-2 text-pi-dim ml-auto flex-wrap">
              {sessionStats.tokens.input > 0 && <span>↑{formatTokens(sessionStats.tokens.input)}</span>}
              {sessionStats.tokens.output > 0 && <span>↓{formatTokens(sessionStats.tokens.output)}</span>}
              {sessionStats.tokens.cacheRead > 0 && <span>r{formatTokens(sessionStats.tokens.cacheRead)}</span>}
              {sessionStats.tokens.cacheWrite > 0 && <span>w{formatTokens(sessionStats.tokens.cacheWrite)}</span>}
              {sessionStats.cost > 0 && <span>${sessionStats.cost.toFixed(3)}</span>}
              {currentModel?.contextWindow && contextUsageTokens && (() => {
                const pct = (contextUsageTokens / currentModel.contextWindow!) * 100;
                const color = pct > 90 ? "text-pi-error" : pct > 70 ? "text-pi-warning" : "";
                return <span className={color}>{pct.toFixed(1)}%/{formatTokens(currentModel.contextWindow!)}</span>;
              })()}
            </span>
          )}
          {isStreaming && <span>responding{promptQueue.length > 0 ? ` · ${promptQueue.length} queued` : ""}</span>}
        </div>

        <div className="px-4 pb-4 pt-3 md:px-6 border-t border-pi-border-muted bg-pi-card-bg">
          <div className="flex gap-2 items-center">
            <textarea
              ref={inputRef}
              rows={1}
              placeholder={hasActiveSession ? "send a message..." : "select a session to start"}
              disabled={!hasActiveSession}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
              }}
              className="flex-1 bg-white border border-pi-border-muted rounded-lg px-3 py-2.5 text-base md:text-sm font-mono resize-none min-h-[42px] max-h-[200px] outline-none focus:border-pi-accent disabled:opacity-50 disabled:cursor-default"
            />
            <div className="flex flex-row gap-1 flex-shrink-0">
              <button
                onClick={sendPrompt}
                disabled={!isConnected || !hasActiveSession}
                title={isStreaming ? "queue message" : "send"}
                className="relative bg-pi-accent text-white p-2 rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-default hover:opacity-85"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="9" x2="16" y2="9" /><polyline points="10,3 16,9 10,15" />
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
                className="bg-pi-error text-white p-2 rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-default hover:opacity-85"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                  <rect x="4" y="4" width="10" height="10" rx="1.5" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageBubble({ msg }: { msg: MessageEntry }) {
  const isUser = msg.role === "user";
  return (
    <div className="mb-4 min-w-0">
      <div className="flex items-center gap-2 mb-1 min-w-0">
        <span className="text-[11px] font-semibold tracking-wide text-pi-muted shrink-0">
          {isUser ? "you" : "assistant"}
        </span>
        {!isUser && (msg.model || msg.provider) && (
          <span className="text-[10px] text-pi-dim truncate">
            {[msg.provider, msg.model].filter(Boolean).join(" / ")}
          </span>
        )}
        {msg.timestamp != null && (
          <span className="text-[10px] text-pi-dim ml-auto shrink-0">
            {formatTime(msg.timestamp)}
          </span>
        )}
      </div>
      <div className={`rounded-lg px-4 py-3 min-w-0 overflow-hidden ${isUser ? "bg-pi-user-bg" : "bg-pi-card-bg border border-pi-border-muted"}`}>
        <div className="text-xs md:text-sm leading-relaxed break-words min-w-0">
          {msg.parts.map((part, index) => (
            <Part key={`${msg.id}-${index}`} part={part} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FolderGroup({
  folder,
  expanded,
  activeSessionFile,
  onToggle,
  onNewSession,
  onSelectSession,
  onDeleteSession,
}: {
  folder: Folder;
  expanded: boolean;
  activeSessionFile: string | null;
  onToggle: () => void;
  onNewSession: () => void;
  onSelectSession: (file: string) => void;
  onDeleteSession: (file: string) => void;
}) {
  const hasActive = folder.sessions.some((s) => s.file === activeSessionFile);
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1 rounded-lg">
        <button
          onClick={onToggle}
          className={`flex-1 flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg text-xs font-semibold hover:bg-pi-user-bg cursor-pointer min-w-0 ${hasActive ? "text-pi-accent" : "text-gray-700"}`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`text-pi-muted transition-transform duration-150 flex-shrink-0 ${expanded ? "rotate-90" : ""}`}><polyline points="3,2 9,6 3,10" /></svg>
          <span className="flex-1 truncate min-w-0">{folder.label}</span>
          <span className="text-[11px] text-pi-dim font-normal flex-shrink-0">{folder.sessions.length}</span>
        </button>
        <button
          onClick={onNewSession}
          title="new session here"
          className="text-pi-muted hover:text-pi-accent hover:bg-pi-user-bg p-1.5 rounded-lg cursor-pointer flex-shrink-0"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="6.5" y1="1.5" x2="6.5" y2="11.5" /><line x1="1.5" y1="6.5" x2="11.5" y2="6.5" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="pl-3 mt-0.5">
          {folder.sessions.map((session) => {
            const active = session.file === activeSessionFile;
            const label = session.firstPrompt || session.id.slice(0, 8);
            const time = session.timestamp ? new Date(session.timestamp).toLocaleString() : "";
            return (
              <div
                key={session.file}
                onClick={() => onSelectSession(session.file)}
                className={`group relative px-2.5 py-2 rounded-lg cursor-pointer mb-0.5 border ${active ? "border-pi-accent bg-pi-user-bg" : "border-transparent hover:bg-pi-user-bg"}`}
              >
                <div className="text-xs truncate pr-5">{label}</div>
                <div className="text-[11px] text-pi-dim mt-0.5">{session.messageCount} msgs · {time}</div>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteSession(session.file); }}
                  title="delete session"
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 hidden group-hover:flex active:flex items-center justify-center w-5 h-5 rounded text-pi-muted bg-pi-user-bg hover:text-pi-error hover:bg-pi-tool-error cursor-pointer"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" /><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
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
  if (part.type === "text") {
    return <div dangerouslySetInnerHTML={{ __html: formatText(part.content || "") }} />;
  }
  if (part.type === "thinking") {
    return (
      <div className="text-pi-muted italic border-l-2 border-pi-border-muted pl-3 my-1.5 text-xs">
        {part.content}
      </div>
    );
  }
  if (part.type === "tool") {
    return <ToolPart part={part} />;
  }
  return null;
}

function ToolPart({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false);
  const args = part.args
    ? typeof part.args === "string" ? part.args : JSON.stringify(part.args, null, 2)
    : "";
  const output = part.content || "";
  const hasDetails = args || output;

  return (
    <div className="bg-pi-tool-success border border-pi-border-muted rounded-lg my-1.5 text-xs overflow-hidden">
      <button
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left ${hasDetails ? "cursor-pointer hover:brightness-95" : "cursor-default"}`}
      >
        <span className="text-pi-success font-semibold">{part.name}</span>
        {!open && args && (
          <span className="text-pi-muted truncate flex-1">{args.slice(0, 80)}{args.length > 80 ? "…" : ""}</span>
        )}
        {hasDetails && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`ml-auto text-pi-dim flex-shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
            <polyline points="1,3 5,7 9,3" />
          </svg>
        )}
      </button>
      {open && (
        <div className="border-t border-pi-border-muted">
          {args && (
            <div className="px-3 py-2 border-b border-pi-border-muted/40">
              <div className="text-[10px] font-semibold text-pi-muted mb-1">input</div>
              <pre className="whitespace-pre-wrap break-all text-pi-muted font-mono">{args}</pre>
            </div>
          )}
          {output && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-semibold text-pi-muted mb-1">output</div>
              <pre className="whitespace-pre-wrap break-all text-pi-tool-output max-h-48 overflow-y-auto font-mono">{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatText(raw: string): string {
  const lines = raw.split("\n");
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
      out.push(`<pre class="bg-pi-page-bg border border-pi-border-muted rounded-lg p-3 overflow-x-auto my-2 text-xs font-mono text-pi-md-code-block"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${code.join("\n")}</code></pre>`);
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
      const ths = headers.map((h, ci) => `<th class="border border-pi-border-muted px-3 py-1.5 bg-pi-page-bg font-semibold text-left" style="${alignStyle(aligns[ci])}">${inlineFormat(h)}</th>`).join("");
      const trs = rows.map((row) =>
        `<tr>${row.map((cell, ci) => `<td class="border border-pi-border-muted px-3 py-1.5" style="${alignStyle(aligns[ci])}">${inlineFormat(cell)}</td>`).join("")}</tr>`
      ).join("");
      out.push(`<div class="overflow-x-auto my-2"><table class="border-collapse text-xs w-full"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }

    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const sizes = ["text-lg", "text-base", "text-sm", "text-sm", "text-xs", "text-xs"];
      out.push(`<h${level} class="font-semibold ${sizes[level - 1]} mt-3 mb-1 text-pi-md-heading">${inlineFormat(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push(`<hr class="border-t border-pi-border-muted my-3">`);
      i++;
      continue;
    }

    if (line.trim() === "") {
      out.push("<br>");
      i++;
      continue;
    }

    out.push(`<span>${inlineFormat(line)}</span><br>`);
    i++;
  }

  return out.join("");
}

function parseTableRow(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function parseTableAligns(sep: string): string[] {
  return sep.replace(/^\||\|$/g, "").split("|").map((c) => {
    c = c.trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    return "left";
  });
}

function alignStyle(align: string): string {
  return `text-align:${align}`;
}

function inlineFormat(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, `<code class="bg-pi-page-bg text-pi-md-code px-1 py-0.5 rounded text-xs font-mono">$1</code>`);
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del class='opacity-60'>$1</del>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" target="_blank" rel="noopener" class="text-pi-md-link underline">$1</a>`);
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function getUsageTokens(usage?: Usage): number {
  if (!usage) return 0;
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? usage.input : 0;
  const output = typeof usage.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
  const cacheRead = typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
  const cacheWrite = typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
  return input + output + cacheRead + cacheWrite;
}

function estimateMessageTokens(message: MessageEntry): number {
  let chars = 0;
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "thinking") {
      chars += (part.content ?? "").length;
      continue;
    }
    if (part.type === "tool") {
      chars += (part.name ?? "").length;
      chars += (part.content ?? "").length;
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
    if (message.role !== "assistant") continue;
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

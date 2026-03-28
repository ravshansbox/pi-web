import { useEffect, useMemo, useRef, useState } from 'react';

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type RunState = 'idle' | 'running' | 'success' | 'error';
type ModelOption = {
  provider: string;
  id: string;
  label: string;
};
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
};
type FolderOption = {
  name: string;
  path: string;
};
type SessionOption = {
  id: string;
  label: string;
};

type ServerMessage =
  | {
      type: 'connected';
      homeFolder: string;
      browserPath: string;
      folders: FolderOption[];
      availableModels: ModelOption[];
      selectedFolder: string | null;
      selectedSession: string | null;
      sessions: SessionOption[];
      provider: string;
      model: string;
      thinkingLevel: ThinkingLevel;
      availableThinkingLevels: ThinkingLevel[];
      messages: ChatMessage[];
    }
  | { type: 'folders_list'; browserPath: string; folders: FolderOption[] }
  | { type: 'folder_selected'; path: string; sessions: SessionOption[] }
  | {
      type: 'session_selected';
      session: string;
      messages: ChatMessage[];
      provider: string;
      model: string;
      thinkingLevel: ThinkingLevel;
      availableThinkingLevels: ThinkingLevel[];
      sessions: SessionOption[];
    }
  | { type: 'model_selected'; provider: string; model: string; thinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] }
  | { type: 'thinking_level_selected'; thinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] }
  | { type: 'run_started' }
  | { type: 'text_delta'; delta: string }
  | { type: 'run_completed'; output: string }
  | { type: 'run_failed'; error: string };

const socketUrl = `${window.location.origin.replace(/^http/, 'ws')}/ws`;

function getUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    folder: params.get('folder') || '',
    session: params.get('session') || '',
  };
}

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingAssistantIdRef = useRef<string | null>(null);
  const restoreRef = useRef(getUrlState());
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [runState, setRunState] = useState<RunState>('idle');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [availableThinkingLevels, setAvailableThinkingLevels] = useState<ThinkingLevel[]>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const [browserPath, setBrowserPath] = useState('');
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [selectedSession, setSelectedSession] = useState('');

  useEffect(() => {
    const socket = new WebSocket(socketUrl);
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      setConnectionState('connected');
      setError('');
    });

    socket.addEventListener('close', () => {
      setConnectionState('disconnected');
      setRunState((current) => (current === 'running' ? 'error' : current));
      setError((current) => current || 'Connection lost.');
      pendingAssistantIdRef.current = null;
    });

    socket.addEventListener('error', () => {
      setConnectionState('disconnected');
      setRunState('error');
      setError('Could not connect to the local pi backend.');
      pendingAssistantIdRef.current = null;
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data) as ServerMessage;

      switch (message.type) {
        case 'connected': {
          setConnectionState('connected');
          setAvailableModels(message.availableModels);
          setSelectedProvider(message.provider);
          setSelectedModel(message.model);
          setBrowserPath(message.browserPath);
          setFolders(message.folders);
          setSessions(message.sessions);
          setMessages(message.messages);
          setSelectedFolder(message.selectedFolder || '');
          setSelectedSession(message.selectedSession || '');
          setThinkingLevel(message.thinkingLevel);
          setAvailableThinkingLevels(message.availableThinkingLevels);

          const restore = restoreRef.current;
          if (restore.folder) {
            socket.send(JSON.stringify({ type: 'set_folder', path: restore.folder }));
          }
          return;
        }
        case 'folders_list':
          setBrowserPath(message.browserPath);
          setFolders(message.folders);
          return;
        case 'folder_selected': {
          setSelectedFolder(message.path);
          setSelectedSession('');
          setSessions(message.sessions);
          setMessages([]);
          setRunState('idle');
          setError('');

          const restore = restoreRef.current;
          if (restore.folder === message.path && restore.session) {
            socket.send(JSON.stringify({ type: 'set_session', session: restore.session }));
            restoreRef.current = { folder: restore.folder, session: '' };
            return;
          }

          restoreRef.current = { folder: '', session: '' };
          return;
        }
        case 'session_selected':
          setSelectedSession(message.session);
          setMessages(message.messages);
          setSelectedProvider(message.provider);
          setSelectedModel(message.model);
          setThinkingLevel(message.thinkingLevel);
          setAvailableThinkingLevels(message.availableThinkingLevels);
          setSessions(message.sessions);
          setRunState('idle');
          setError('');
          restoreRef.current = { folder: '', session: '' };
          return;
        case 'model_selected':
          setSelectedProvider(message.provider);
          setSelectedModel(message.model);
          setThinkingLevel(message.thinkingLevel);
          setAvailableThinkingLevels(message.availableThinkingLevels);
          setError('');
          setRunState('idle');
          pendingAssistantIdRef.current = null;
          return;
        case 'thinking_level_selected':
          setThinkingLevel(message.thinkingLevel);
          setAvailableThinkingLevels(message.availableThinkingLevels);
          setError('');
          return;
        case 'run_started': {
          const assistantId = `assistant-${crypto.randomUUID()}`;
          pendingAssistantIdRef.current = assistantId;
          setRunState('running');
          setError('');
          setMessages((current) => [...current, { id: assistantId, role: 'assistant', text: '' }]);
          return;
        }
        case 'text_delta': {
          const assistantId = pendingAssistantIdRef.current;
          if (assistantId === null) {
            return;
          }

          setMessages((current) =>
            current.map((entry) =>
              entry.id === assistantId ? { ...entry, text: entry.text + message.delta } : entry,
            ),
          );
          return;
        }
        case 'run_completed': {
          const assistantId = pendingAssistantIdRef.current;
          pendingAssistantIdRef.current = null;
          setRunState('success');

          if (assistantId === null) {
            setMessages((current) => [
              ...current,
              { id: `assistant-${crypto.randomUUID()}`, role: 'assistant', text: message.output },
            ]);
            return;
          }

          setMessages((current) =>
            current.map((entry) =>
              entry.id === assistantId ? { ...entry, text: entry.text || message.output } : entry,
            ),
          );
          return;
        }
        case 'run_failed':
          pendingAssistantIdRef.current = null;
          setError(message.error);
          setRunState('error');
          setMessages((current) => [
            ...current,
            { id: `error-${crypto.randomUUID()}`, role: 'error', text: message.error },
          ]);
          return;
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedFolder) {
      params.set('folder', selectedFolder);
    }
    if (selectedSession) {
      params.set('session', selectedSession);
    }
    const search = params.toString();
    const nextUrl = search ? `?${search}` : window.location.pathname;
    window.history.replaceState(null, '', nextUrl);
  }, [selectedFolder, selectedSession]);

  const providerOptions = useMemo(
    () => Array.from(new Set(availableModels.map((model) => model.provider))).sort(),
    [availableModels],
  );

  const modelOptions = useMemo(
    () => availableModels.filter((model) => model.provider === selectedProvider),
    [availableModels, selectedProvider],
  );

  const surfaceClass = 'border-[#d7ded3] bg-white/90 shadow-sm';
  const pageClass = 'bg-[#eef3ea] text-zinc-950';
  const mutedTextClass = 'text-zinc-700';
  const inputClass = 'border-[#cfd8ca] bg-white text-zinc-950 focus:border-[#7b8d80]';
  const secondaryButtonClass = 'border-[#cfd8ca] text-zinc-700 disabled:opacity-40';
  const primaryButtonClass = 'bg-[#8fa892] text-zinc-950 disabled:bg-[#cfd8ca] disabled:text-[#6f7c73]';

  const statusText = useMemo(() => {
    if (connectionState === 'connecting') {
      return error || 'Connecting to local pi backend…';
    }

    if (connectionState === 'disconnected') {
      return 'Disconnected from local pi backend.';
    }

    if (runState === 'running') {
      return 'pi is responding…';
    }

    if (runState === 'error' && error) {
      return error;
    }

    return '';
  }, [connectionState, error, runState]);

  const canSubmit =
    connectionState === 'connected' &&
    runState !== 'running' &&
    prompt.trim().length > 0 &&
    selectedProvider.length > 0 &&
    selectedModel.length > 0 &&
    selectedSession.length > 0;

  const handleAction = () => {
    if (socketRef.current === null) {
      return;
    }

    if (runState === 'running') {
      socketRef.current.send(JSON.stringify({ type: 'abort' }));
      return;
    }

    if (!canSubmit) {
      return;
    }

    const trimmedPrompt = prompt.trim();
    setMessages((current) => [
      ...current,
      { id: `user-${crypto.randomUUID()}`, role: 'user', text: trimmedPrompt },
    ]);
    setPrompt('');

    socketRef.current.send(JSON.stringify({ type: 'prompt', prompt: trimmedPrompt }));
  };

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    const nextModel = availableModels.find((model) => model.provider === provider);
    if (nextModel === undefined || socketRef.current === null) {
      return;
    }

    setSelectedModel(nextModel.id);
    socketRef.current.send(JSON.stringify({ type: 'set_model', provider, model: nextModel.id }));
  };

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    if (socketRef.current === null || selectedProvider.length === 0) {
      return;
    }

    socketRef.current.send(JSON.stringify({ type: 'set_model', provider: selectedProvider, model }));
  };

  const browseFolder = (path: string) => {
    socketRef.current?.send(JSON.stringify({ type: 'list_folders', path }));
  };

  const chooseFolder = (path: string) => {
    socketRef.current?.send(JSON.stringify({ type: 'set_folder', path }));
  };

  const resetFolderSelection = () => {
    setSelectedFolder('');
    setSelectedSession('');
    setSessions([]);
    setMessages([]);
    setPrompt('');
    setRunState('idle');
    setError('');
  };

  const resetSessionSelection = () => {
    setSelectedSession('');
    setMessages([]);
    setPrompt('');
    setRunState('idle');
    setError('');
  };

  const currentFolderName = browserPath.split('/').at(-1) || 'Home';
  const canGoUp = browserPath.length > 0;
  const parentPath = browserPath.split('/').slice(0, -1).join('/');

  return (
    <main className={`min-h-dvh px-4 py-4 font-['JetBrains_Mono',ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation_Mono','Courier_New',monospace] sm:px-6 sm:py-10 ${pageClass}`}>
      <div className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col gap-4 sm:min-h-[calc(100dvh-5rem)] sm:gap-6">
        {!selectedFolder ? (
          <section className={`rounded-2xl border p-4 sm:p-5 ${surfaceClass}`}>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm">{browserPath || 'Home'}</p>
                {canGoUp ? (
                  <button
                    type="button"
                    onClick={() => browseFolder(parentPath)}
                    className={`rounded-xl border px-3 py-2 text-sm transition ${secondaryButtonClass}`}
                  >
                    Up
                  </button>
                ) : null}
              </div>

              <div className="space-y-2">
                {folders.length > 0 ? (
                  folders.map((folder) => (
                    <div key={folder.path} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => browseFolder(folder.path)}
                        className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-left text-base transition sm:text-sm ${inputClass}`}
                      >
                        {folder.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => chooseFolder(folder.path)}
                        className={`rounded-xl px-3 py-2 text-base font-medium transition sm:text-sm ${primaryButtonClass}`}
                      >
                        Use
                      </button>
                    </div>
                  ))
                ) : (
                  <p className={`text-sm ${mutedTextClass}`}>No folders found in {currentFolderName}.</p>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {selectedFolder && !selectedSession ? (
          <section className={`rounded-2xl border p-4 sm:p-5 ${surfaceClass}`}>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm">{selectedFolder}</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={resetFolderSelection}
                    className={`rounded-xl border px-3 py-2 text-sm transition ${secondaryButtonClass}`}
                  >
                    Change folder
                  </button>
                  <button
                    type="button"
                    onClick={() => socketRef.current?.send(JSON.stringify({ type: 'create_session' }))}
                    className={`rounded-xl px-3 py-2 text-sm font-medium transition ${primaryButtonClass}`}
                    disabled={connectionState !== 'connected' || runState === 'running'}
                  >
                    New session
                  </button>
                </div>
              </div>

              {sessions.length > 0 ? (
                <div className="space-y-2">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => socketRef.current?.send(JSON.stringify({ type: 'set_session', session: session.id }))}
                      className={`block w-full rounded-xl border px-3 py-2 text-left text-base transition sm:text-sm ${
                        selectedSession === session.id ? primaryButtonClass : inputClass
                      }`}
                    >
                      {session.label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className={`text-sm ${mutedTextClass}`}>No sessions yet. Create a new one.</p>
              )}
            </div>
          </section>
        ) : null}

        {selectedSession ? (
          <>
            <section className={`flex-1 rounded-2xl border p-4 sm:p-5 ${surfaceClass}`}>
              <div className="mb-4 flex justify-end">
                <button
                  type="button"
                  onClick={resetSessionSelection}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${secondaryButtonClass}`}
                >
                  Change session
                </button>
              </div>
              {messages.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {messages.map((message) => {
                    const messageClass =
                      message.role === 'user'
                        ? 'self-end bg-[#8fa892] text-zinc-950'
                        : message.role === 'error'
                          ? 'self-start bg-red-100 text-red-700'
                          : 'self-start bg-[#f3f6f0] text-zinc-950';

                    return (
                      <article key={message.id} className="flex">
                        <div className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-6 ${messageClass}`}>
                          <pre className="whitespace-pre-wrap break-words">{message.text || '…'}</pre>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className={`text-sm leading-6 ${mutedTextClass}`}>
                  Your conversation history will appear here.
                </p>
              )}
            </section>

            <section
              className={`sticky rounded-2xl border p-2.5 sm:p-3 ${surfaceClass}`}
              style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2">
                  <select
                    className={`w-full rounded-xl border px-3 py-2 text-base outline-none transition sm:text-sm ${inputClass}`}
                    value={selectedProvider}
                    onChange={(event) => handleProviderChange(event.target.value)}
                    disabled={connectionState !== 'connected' || runState === 'running' || providerOptions.length === 0}
                  >
                    {providerOptions.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>

                  <select
                    className={`w-full rounded-xl border px-3 py-2 text-base outline-none transition sm:text-sm ${inputClass}`}
                    value={selectedModel}
                    onChange={(event) => handleModelChange(event.target.value)}
                    disabled={connectionState !== 'connected' || runState === 'running' || modelOptions.length === 0}
                  >
                    {modelOptions.map((model) => (
                      <option key={`${model.provider}-${model.id}`} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>

                  <select
                    className={`w-full rounded-xl border px-3 py-2 text-base outline-none transition sm:text-sm ${inputClass}`}
                    value={thinkingLevel}
                    onChange={(event) =>
                      socketRef.current?.send(
                        JSON.stringify({ type: 'set_thinking_level', level: event.target.value }),
                      )
                    }
                    disabled={connectionState !== 'connected' || runState === 'running' || selectedSession.length === 0}
                  >
                    {availableThinkingLevels.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </div>

                {statusText ? (
                  <p className={`text-xs ${mutedTextClass}`} aria-live="polite">
                    {statusText}
                  </p>
                ) : null}

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleAction();
                  }}
                >
                  <div className={`flex items-center gap-1.5 rounded-xl border p-1 ${inputClass}`}>
                    <input
                      type="text"
                      className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-base leading-6 outline-none sm:text-sm sm:leading-5"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="Ask pi to inspect code, explain a file, or make a change."
                      disabled={connectionState !== 'connected' || runState === 'running'}
                    />
                    <button
                      type="submit"
                      className={`shrink-0 rounded-lg px-4 py-2 text-base leading-6 font-medium transition disabled:cursor-not-allowed sm:px-5 sm:text-sm sm:leading-5 ${
                        runState === 'running' ? secondaryButtonClass : primaryButtonClass
                      }`}
                      disabled={runState !== 'running' && !canSubmit}
                    >
                      {runState === 'running' ? 'Stop' : 'Send'}
                    </button>
                  </div>
                </form>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

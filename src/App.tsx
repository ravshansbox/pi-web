import { useEffect, useMemo, useRef, useState } from 'react';

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

type ServerMessage =
  | { type: 'connected'; provider: string; model: string; availableModels: ModelOption[] }
  | { type: 'model_selected'; provider: string; model: string }
  | { type: 'run_started' }
  | { type: 'text_delta'; delta: string }
  | { type: 'run_completed'; output: string }
  | { type: 'run_failed'; error: string };

const socketUrl = `${window.location.origin.replace(/^http/, 'ws')}/ws`;

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingAssistantIdRef = useRef<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [runState, setRunState] = useState<RunState>('idle');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);

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
        case 'connected':
          setConnectionState('connected');
          setAvailableModels(message.availableModels);
          setSelectedProvider(message.provider);
          setSelectedModel(message.model);
          return;
        case 'model_selected':
          setSelectedProvider(message.provider);
          setSelectedModel(message.model);
          setError('');
          setRunState('idle');
          pendingAssistantIdRef.current = null;
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
              entry.id === assistantId
                ? { ...entry, text: entry.text || message.output }
                : entry,
            ),
          );
          return;
        }
        case 'run_failed':
          pendingAssistantIdRef.current = null;
          setError(message.error);
          setRunState('error');
          if (message.error === 'pi session is still starting. Try again.') {
            setConnectionState('connecting');
          }
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
    selectedModel.length > 0;

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

    socketRef.current.send(
      JSON.stringify({
        type: 'prompt',
        prompt: trimmedPrompt,
      }),
    );
  };

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    const nextModel = availableModels.find((model) => model.provider === provider);
    if (nextModel === undefined || socketRef.current === null) {
      return;
    }

    setSelectedModel(nextModel.id);
    socketRef.current.send(
      JSON.stringify({
        type: 'set_model',
        provider,
        model: nextModel.id,
      }),
    );
  };

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    if (socketRef.current === null || selectedProvider.length === 0) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: 'set_model',
        provider: selectedProvider,
        model,
      }),
    );
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handleAction();
  };

  return (
    <main className={`min-h-dvh px-4 py-4 sm:px-6 sm:py-10 ${pageClass}`}>
      <div className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col gap-4 sm:min-h-[calc(100dvh-5rem)] sm:gap-6">

        <section className={`flex-1 rounded-2xl border p-4 sm:p-5 ${surfaceClass}`}>

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
                      <pre className="whitespace-pre-wrap break-words font-sans">{message.text || '…'}</pre>
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
            <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2">
              <label className="block space-y-1.5">
                <span className={`text-xs font-medium ${mutedTextClass}`}>Provider</span>
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
              </label>

              <label className="block space-y-1.5">
                <span className={`text-xs font-medium ${mutedTextClass}`}>Model</span>
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
              </label>
            </div>

            {statusText ? (
              <p className={`text-xs ${mutedTextClass}`} aria-live="polite">
                {statusText}
              </p>
            ) : null}

            <form className="space-y-1.5" onSubmit={handleSubmit}>
              <label className="block space-y-1.5">
                <span className={`text-xs font-medium ${mutedTextClass}`}>Prompt</span>
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
                    className={`shrink-0 rounded-lg px-4 py-2 text-base leading-6 font-medium transition disabled:cursor-not-allowed sm:px-5 sm:text-sm sm:leading-5 ${runState === 'running' ? secondaryButtonClass : primaryButtonClass}`}
                    disabled={runState !== 'running' && !canSubmit}
                  >
                    {runState === 'running' ? 'Stop' : 'Send'}
                  </button>
                </div>
              </label>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, normalize, relative, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { AuthStorage, ModelRegistry, SessionManager, createAgentSession } from '@mariozechner/pi-coding-agent';
import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

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

type ModelOption = {
  provider: string;
  id: string;
  label: string;
};

type ClientMessage =
  | { type: 'prompt'; prompt: string }
  | { type: 'abort' }
  | { type: 'set_model'; provider: string; model: string }
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'list_folders'; path: string }
  | { type: 'set_folder'; path: string }
  | { type: 'create_session' }
  | { type: 'set_session'; session: string };

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

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);
const availableModels = modelRegistry
  .getAvailable()
  .map((model) => ({ provider: model.provider, id: model.id, label: `${model.provider} / ${model.id}` }))
  .sort((left, right) => left.label.localeCompare(right.label));
const defaultModel = modelRegistry.getAvailable().at(0);
if (defaultModel === undefined) {
  throw new Error('Could not find any available pi models.');
}

const HOME = homedir();
const PORT = Number(process.env.PORT ?? '3001');

function resolveHomePath(path: string) {
  if (path.startsWith('/')) {
    throw new Error('Absolute paths are not allowed.');
  }

  const normalised = normalize(path).replace(/^\.(\/|$)/, '');
  if (normalised === '..' || normalised.startsWith('../')) {
    throw new Error('Path must stay inside your home folder.');
  }

  const absolutePath = resolve(HOME, normalised);
  const relativePath = relative(HOME, absolutePath);
  if (relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error('Path must stay inside your home folder.');
  }

  return {
    absolutePath,
    relativePath: relativePath === '' ? '' : relativePath,
  };
}

async function listFolders(path: string) {
  const { absolutePath, relativePath } = resolveHomePath(path);
  const entries = await readdir(absolutePath, { withFileTypes: true });

  return {
    browserPath: relativePath,
    folders: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function listSessions(path: string) {
  const { absolutePath } = resolveHomePath(path);
  const sessions = await SessionManager.list(absolutePath);

  return sessions
    .sort((left, right) => right.modified.getTime() - left.modified.getTime())
    .map((session) => ({
      id: session.id,
      label: session.name || session.firstMessage || `${basename(path || HOME)} session`,
    }));
}

function getMessageText(message: AgentMessage) {
  if (message.role === 'user') {
    return typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('');
  }

  if (message.role === 'assistant') {
    return message.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
  }

  return '';
}

function toChatMessages(messages: AgentMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }

    const text = getMessageText(message).trim();
    if (!text) {
      return [];
    }

    return [{ id: `${message.role}-${message.timestamp}`, role: message.role, text }];
  });
}

const httpServer = createServer();
const wsServer = new WebSocketServer({ server: httpServer });

wsServer.on('connection', async (socket) => {
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  let unsubscribe = () => {};
  let activeRun = false;
  let responseText = '';
  let selectedModel = defaultModel;
  let selectedFolder: string | null = null;
  let selectedSession: string | null = null;
  let currentSessions: SessionOption[] = [];

  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const disposeSession = () => {
    unsubscribe();
    unsubscribe = () => {};
    session?.dispose();
    session = null;
    activeRun = false;
    responseText = '';
    selectedSession = null;
  };

  const connectSession = async (sessionManager: SessionManager) => {
    unsubscribe();
    session?.dispose();

    const result = await createAgentSession({
      cwd: sessionManager.getCwd(),
      authStorage,
      modelRegistry,
      model: selectedModel,
      sessionManager,
    });

    session = result.session;
    selectedModel = session.model ?? selectedModel;
    selectedSession = session.sessionId;

    unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        responseText += event.assistantMessageEvent.delta;
        send({ type: 'text_delta', delta: event.assistantMessageEvent.delta });
        return;
      }

      if (event.type !== 'agent_end' || !activeRun) {
        return;
      }

      const assistantMessage = event.messages.at(-1);
      if (assistantMessage?.role === 'assistant' && assistantMessage.stopReason === 'error') {
        activeRun = false;
        responseText = '';
        send({ type: 'run_failed', error: assistantMessage.errorMessage || 'Request failed.' });
        return;
      }

      activeRun = false;
      send({ type: 'run_completed', output: responseText.trim() || 'No response returned.' });
    });
  };

  socket.on('message', async (raw) => {
    let message: ClientMessage;

    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send({ type: 'run_failed', error: 'Invalid message.' });
      return;
    }

    try {
      if (message.type === 'list_folders') {
        const result = await listFolders(message.path);
        send({ type: 'folders_list', browserPath: result.browserPath, folders: result.folders });
        return;
      }

      if (message.type === 'set_folder') {
        if (activeRun) {
          send({ type: 'run_failed', error: 'Stop the current request before changing folder.' });
          return;
        }

        const { relativePath } = resolveHomePath(message.path);
        disposeSession();
        selectedFolder = relativePath;
        currentSessions = await listSessions(relativePath);
        send({ type: 'folder_selected', path: relativePath, sessions: currentSessions });
        return;
      }

      if (message.type === 'create_session') {
        if (selectedFolder === null) {
          send({ type: 'run_failed', error: 'Choose a folder first.' });
          return;
        }

        if (activeRun) {
          send({ type: 'run_failed', error: 'Stop the current request before changing session.' });
          return;
        }

        const { absolutePath } = resolveHomePath(selectedFolder);
        await connectSession(SessionManager.create(absolutePath));
        currentSessions = await listSessions(selectedFolder);
        send({
          type: 'session_selected',
          session: selectedSession || session?.sessionId || '',
          messages: toChatMessages(session?.messages ?? []),
          provider: selectedModel.provider,
          model: selectedModel.id,
          thinkingLevel: session?.thinkingLevel || 'medium',
          availableThinkingLevels: session?.getAvailableThinkingLevels() || ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
          sessions: currentSessions,
        });
        return;
      }

      if (message.type === 'set_session') {
        if (selectedFolder === null) {
          send({ type: 'run_failed', error: 'Choose a folder first.' });
          return;
        }

        if (activeRun) {
          send({ type: 'run_failed', error: 'Stop the current request before changing session.' });
          return;
        }

        const { absolutePath } = resolveHomePath(selectedFolder);
        const sessions = await SessionManager.list(absolutePath);
        const nextSession = sessions.find((entry) => entry.id === message.session);
        if (nextSession === undefined) {
          send({ type: 'run_failed', error: 'Selected session was not found.' });
          return;
        }

        await connectSession(SessionManager.open(nextSession.path));
        currentSessions = await listSessions(selectedFolder);
        send({
          type: 'session_selected',
          session: selectedSession || message.session,
          messages: toChatMessages(session?.messages ?? []),
          provider: selectedModel.provider,
          model: selectedModel.id,
          thinkingLevel: session?.thinkingLevel || 'medium',
          availableThinkingLevels: session?.getAvailableThinkingLevels() || ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
          sessions: currentSessions,
        });
        return;
      }

      if (message.type === 'set_model') {
        if (activeRun) {
          send({ type: 'run_failed', error: 'Stop the current request before changing model.' });
          return;
        }

        const nextModel = modelRegistry.find(message.provider, message.model);
        if (nextModel === undefined) {
          send({ type: 'run_failed', error: 'Selected model is not available.' });
          return;
        }

        selectedModel = nextModel;

        if (session !== null) {
          const currentSessionFile = session.sessionFile;
          if (currentSessionFile !== undefined) {
            await connectSession(SessionManager.open(currentSessionFile));
          }
        }

        send({
          type: 'model_selected',
          provider: selectedModel.provider,
          model: selectedModel.id,
          thinkingLevel: session?.thinkingLevel || 'medium',
          availableThinkingLevels: session?.getAvailableThinkingLevels() || ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        });
        return;
      }

      if (message.type === 'set_thinking_level') {
        if (session === null) {
          send({ type: 'run_failed', error: 'Choose a session first.' });
          return;
        }

        if (activeRun) {
          send({ type: 'run_failed', error: 'Stop the current request before changing thinking level.' });
          return;
        }

        session.setThinkingLevel(message.level);
        send({
          type: 'thinking_level_selected',
          thinkingLevel: session.thinkingLevel,
          availableThinkingLevels: session.getAvailableThinkingLevels(),
        });
        return;
      }

      if (session === null) {
        send({ type: 'run_failed', error: 'Choose a session first.' });
        return;
      }

      if (message.type === 'abort') {
        if (!activeRun) {
          return;
        }

        await session.abort();
        activeRun = false;
        send({ type: 'run_failed', error: 'Request aborted.' });
        return;
      }

      const prompt = message.prompt.trim();
      if (prompt.length === 0) {
        send({ type: 'run_failed', error: 'Enter a prompt.' });
        return;
      }

      if (activeRun) {
        send({ type: 'run_failed', error: 'Wait for the current request to finish.' });
        return;
      }

      activeRun = true;
      responseText = '';
      send({ type: 'run_started' });

      try {
        await session.prompt(prompt);
      } catch (error) {
        activeRun = false;
        responseText = '';
        send({
          type: 'run_failed',
          error: error instanceof Error ? error.message : 'Request failed.',
        });
      }
    } catch (error) {
      send({ type: 'run_failed', error: error instanceof Error ? error.message : 'Request failed.' });
    }
  });

  try {
    const initialFolders = await listFolders('');
    send({
      type: 'connected',
      homeFolder: HOME,
      browserPath: initialFolders.browserPath,
      folders: initialFolders.folders,
      availableModels,
      selectedFolder,
      selectedSession,
      sessions: currentSessions,
      provider: selectedModel.provider,
      model: selectedModel.id,
      thinkingLevel: 'medium',
      availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      messages: [],
    });
  } catch (error) {
    send({
      type: 'run_failed',
      error: error instanceof Error ? error.message : 'Could not start pi session.',
    });
    socket.close();
    return;
  }

  socket.on('close', () => {
    disposeSession();
  });
});

httpServer.listen(PORT, () => {
  console.log(`pi-web server listening on http://localhost:${PORT}`);
});

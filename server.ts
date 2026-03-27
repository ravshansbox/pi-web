import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AuthStorage, ModelRegistry, createAgentSession } from '@mariozechner/pi-coding-agent';

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

const PORT = Number(process.env.PORT ?? '3001');

type ClientMessage =
  | { type: 'prompt'; prompt: string }
  | { type: 'abort' }
  | { type: 'set_model'; provider: string; model: string };

type ModelOption = {
  provider: string;
  id: string;
  label: string;
};

type ServerMessage =
  | { type: 'connected'; provider: string; model: string; availableModels: ModelOption[] }
  | { type: 'model_selected'; provider: string; model: string }
  | { type: 'run_started' }
  | { type: 'text_delta'; delta: string }
  | { type: 'run_completed'; output: string }
  | { type: 'run_failed'; error: string };

const httpServer = createServer();
const wsServer = new WebSocketServer({ server: httpServer });

wsServer.on('connection', async (socket) => {
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  let unsubscribe = () => {};
  let activeRun = false;
  let responseText = '';
  let selectedModel = defaultModel;

  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const connectSession = async () => {
    unsubscribe();
    session?.dispose();

    const result = await createAgentSession({
      cwd: process.cwd(),
      authStorage,
      modelRegistry,
      model: selectedModel,
    });

    session = result.session;
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
        send({
          type: 'run_failed',
          error: assistantMessage.errorMessage || 'Request failed.',
        });
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

      try {
        await connectSession();
        send({
          type: 'model_selected',
          provider: selectedModel.provider,
          model: selectedModel.id,
        });
      } catch (error) {
        send({
          type: 'run_failed',
          error: error instanceof Error ? error.message : 'Could not switch model.',
        });
      }
      return;
    }

    if (session === null) {
      send({ type: 'run_failed', error: 'pi session is still starting. Try again.' });
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
  });

  try {
    await connectSession();
    send({
      type: 'connected',
      provider: selectedModel.provider,
      model: selectedModel.id,
      availableModels,
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
    unsubscribe();
    session?.dispose();
  });
});

httpServer.listen(PORT, () => {
  console.log(`pi-web server listening on http://localhost:${PORT}`);
});

import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type AgentKind = 'pi' | 'omp';

const HOME_DIR = resolve(homedir());

function getSessionDir(agent: AgentKind): string {
  const configDir = agent === 'omp' ? '.omp' : '.pi';
  return join(HOME_DIR, configDir, 'agent', 'sessions');
}

export interface SessionSummary {
  id: string;
  file: string;
  cwd: string;
  timestamp: string;
  firstPrompt?: string;
  messageCount: number;
}

export interface ParsedMessage {
  id: string;
  role: string;
  content: any;
  timestamp?: string;
  model?: string;
  provider?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
}

function cwdToSessionDir(cwd: string, agent: AgentKind): string {
  const normalisedCwd = resolve(cwd);

  if (agent === 'omp') {
    if (
      normalisedCwd === HOME_DIR ||
      normalisedCwd.startsWith(`${HOME_DIR}/`) ||
      normalisedCwd.startsWith(`${HOME_DIR}\\`)
    ) {
      const relative = normalisedCwd.slice(HOME_DIR.length).replace(/^[/\\]/, '');
      return `-${relative.replace(/[/\\:]/g, '-')}`;
    }
  }

  const encoded = normalisedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return `--${encoded}--`;
}

export function getSessionFilePath(cwd: string, filename: string, agent: AgentKind = 'pi'): string {
  return join(getSessionDir(agent), cwdToSessionDir(cwd, agent), filename);
}

export async function listSessions(opts: {
  cwd?: string;
  limit?: number;
  agent?: AgentKind;
}): Promise<SessionSummary[]> {
  const { cwd, limit = 30, agent = 'pi' } = opts;
  const results: SessionSummary[] = [];
  const sessionDir = getSessionDir(agent);

  try {
    const cwdDirs = await readdir(sessionDir, { withFileTypes: true });
    const targetDirs = cwd
      ? cwdDirs.filter((d) => d.isDirectory() && d.name === cwdToSessionDir(cwd, agent))
      : cwdDirs.filter((d) => d.isDirectory());

    for (const dir of targetDirs) {
      const dirPath = join(sessionDir, dir.name);
      let files: string[];
      try {
        files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      files.sort((a, b) => b.localeCompare(a));

      for (const file of files) {
        if (results.length >= limit) break;
        const filePath = join(dirPath, file);
        try {
          const info = await readSessionHeader(filePath);
          if (info) results.push(info);
        } catch {}
      }
      if (results.length >= limit) break;
    }
  } catch {}

  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results.slice(0, limit);
}

export async function readSessionMessages(filePath: string): Promise<ParsedMessage[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const messages: ParsedMessage[] = [];
  const toolResults = new Map<
    string,
    {
      content: unknown;
      details?: unknown;
      isError?: boolean;
    }
  >();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{"type":"message"')) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry.type !== 'message' || !entry.message) continue;
        const msg = entry.message;
        const role = msg.role;
        if (!role || role === 'system') continue;

        if (role === 'toolResult' || role === 'tool_result') {
          const id = msg.toolCallId;
          if (id) {
            toolResults.set(id, {
              content: msg.content,
              details: msg.details,
              isError: Boolean(msg.isError),
            });
          }
          continue;
        }

        if (role === 'tool') continue;

        messages.push({
          id: entry.id || crypto.randomUUID(),
          role,
          content: msg.content,
          timestamp: entry.timestamp || msg.timestamp,
          model: msg.model || msg.modelId,
          provider: msg.provider,
          usage: msg.usage,
        });
      } catch {}
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'toolCall' && block.id && toolResults.has(block.id)) {
        const result = toolResults.get(block.id);
        if (!result) continue;
        block.result = {
          content: result.content,
          details: result.details,
          isError: result.isError,
        };
        block.isError = result.isError;
      }
    }
  }

  return messages;
}

async function readSessionHeader(filePath: string): Promise<SessionSummary | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let header: any = null;
  let firstPrompt: string | undefined;
  let messageCount = 0;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (!header) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'session') {
            header = parsed;
            continue;
          }
        } catch {}
      }

      if (trimmed.startsWith('{"type":"message"')) {
        messageCount++;
        if (!firstPrompt && trimmed.includes('"role":"user"')) {
          try {
            const msg = JSON.parse(trimmed);
            if (msg.message?.role === 'user') {
              const content = msg.message.content;
              if (typeof content === 'string') {
                firstPrompt = content.slice(0, 120);
              } else if (Array.isArray(content)) {
                const text = content.find((c: any) => c.type === 'text');
                if (text?.text) firstPrompt = text.text.slice(0, 120);
              }
            }
          } catch {}
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!header) return null;

  return {
    id: header.id,
    file: basename(filePath),
    cwd: header.cwd || '',
    timestamp: header.timestamp || '',
    firstPrompt,
    messageCount,
  };
}

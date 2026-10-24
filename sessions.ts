import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const HOME_DIR = resolve(homedir());

function getSessionDir(): string {
  return join(HOME_DIR, '.pi', 'agent', 'sessions');
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
  content: unknown;
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

function cwdToSessionDir(cwd: string): string {
  const normalisedCwd = resolve(cwd);
  const encoded = normalisedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return `--${encoded}--`;
}

export function getSessionFilePath(cwd: string, filename: string): string {
  return join(getSessionDir(), cwdToSessionDir(cwd), filename);
}

export async function listSessions(opts: {
  cwd?: string;
  limit?: number;
}): Promise<SessionSummary[]> {
  const { cwd, limit = 30 } = opts;
  const results: SessionSummary[] = [];
  const sessionDir = getSessionDir();

  try {
    const cwdDirs = await readdir(sessionDir, { withFileTypes: true });
    const targetDirs = cwd
      ? cwdDirs.filter((d) => d.isDirectory() && d.name === cwdToSessionDir(cwd))
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
        } catch {
          // unreadable session file — skip
        }
      }
      if (results.length >= limit) break;
    }
  } catch {
    // session directory does not exist or is unreadable
  }

  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results.slice(0, limit);
}

export async function readSessionMessages(filePath: string): Promise<ParsedMessage[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const messages: ParsedMessage[] = [];
  const toolResults = new Map<string, { content: unknown; details?: unknown; isError?: boolean }>();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry.type !== 'message' || !entry.message) continue;
        const msg = entry.message;
        const role = msg.role;
        if (!role) continue;

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
      } catch {
        // malformed JSON line — skip
      }
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

  let header: Record<string, unknown> | null = null;
  let firstPrompt: string | undefined;
  let messageCount = 0;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);

        if (!header && parsed.type === 'session') {
          header = parsed;
          continue;
        }

        if (parsed.type !== 'message') continue;

        messageCount++;
        if (!firstPrompt && parsed.message?.role === 'user') {
          const content = parsed.message.content;
          if (typeof content === 'string') {
            firstPrompt = content.slice(0, 120);
          } else if (Array.isArray(content)) {
            const text = content.find((c: unknown) => (c as { type?: string }).type === 'text') as
              | { text?: string }
              | undefined;
            if (text?.text) firstPrompt = text.text.slice(0, 120);
          }
        }
      } catch {
        // malformed JSON line — skip
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!header) return null;

  return {
    id: typeof header.id === 'string' ? header.id : '',
    file: basename(filePath),
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    timestamp: typeof header.timestamp === 'string' ? header.timestamp : '',
    firstPrompt,
    messageCount,
  };
}

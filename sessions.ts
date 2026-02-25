import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

export interface SessionSummary {
  id: string;
  file: string;
  cwd: string;
  timestamp: string;
  firstPrompt?: string;
  messageCount: number;
}

export function cwdToSessionDir(cwd: string): string {
  // /Users/foo/bar → --Users-foo-bar--
  return "-" + cwd.replace(/\//g, "-") + "-";
}

export async function listSessions(opts: {
  cwd?: string;
  limit?: number;
}): Promise<SessionSummary[]> {
  const { cwd, limit = 30 } = opts;
  const results: SessionSummary[] = [];

  try {
    const cwdDirs = await readdir(SESSION_DIR, { withFileTypes: true });
    const targetDirs = cwd
      ? cwdDirs.filter((d) => d.isDirectory() && d.name === cwdToSessionDir(cwd))
      : cwdDirs.filter((d) => d.isDirectory());

    for (const dir of targetDirs) {
      const dirPath = join(SESSION_DIR, dir.name);
      let files: string[];
      try {
        files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }

      // Sort by filename (timestamp-based) descending
      files.sort((a, b) => b.localeCompare(a));

      for (const file of files) {
        if (results.length >= limit) break;
        const filePath = join(dirPath, file);
        try {
          const info = await readSessionHeader(filePath);
          if (info) results.push(info);
        } catch {
          // skip unreadable
        }
      }
      if (results.length >= limit) break;
    }
  } catch {
    // sessions dir might not exist
  }

  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results.slice(0, limit);
}

async function readSessionHeader(filePath: string): Promise<SessionSummary | null> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
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
          if (parsed.type === "session") {
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
            if (msg.message?.role === "user") {
              const content = msg.message.content;
              if (typeof content === "string") {
                firstPrompt = content.slice(0, 120);
              } else if (Array.isArray(content)) {
                const text = content.find((c: any) => c.type === "text");
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
    file: filePath,
    cwd: header.cwd || "",
    timestamp: header.timestamp || "",
    firstPrompt,
    messageCount,
  };
}

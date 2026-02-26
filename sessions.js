import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
const SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");
function cwdToSessionDir(cwd) {
    return "-" + cwd.replace(/\//g, "-") + "-";
}
export async function listSessions(opts) {
    const { cwd, limit = 30 } = opts;
    const results = [];
    try {
        const cwdDirs = await readdir(SESSION_DIR, { withFileTypes: true });
        const targetDirs = cwd
            ? cwdDirs.filter((d) => d.isDirectory() && d.name === cwdToSessionDir(cwd))
            : cwdDirs.filter((d) => d.isDirectory());
        for (const dir of targetDirs) {
            const dirPath = join(SESSION_DIR, dir.name);
            let files;
            try {
                files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
            }
            catch {
                continue;
            }
            files.sort((a, b) => b.localeCompare(a));
            for (const file of files) {
                if (results.length >= limit)
                    break;
                const filePath = join(dirPath, file);
                try {
                    const info = await readSessionHeader(filePath);
                    if (info)
                        results.push(info);
                }
                catch { }
            }
            if (results.length >= limit)
                break;
        }
    }
    catch { }
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return results.slice(0, limit);
}
export async function readSessionMessages(filePath) {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const messages = [];
    const toolResults = new Map();
    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('{"type":"message"'))
                continue;
            try {
                const entry = JSON.parse(trimmed);
                if (entry.type !== "message" || !entry.message)
                    continue;
                const msg = entry.message;
                const role = msg.role;
                if (!role || role === "system")
                    continue;
                if (role === "toolResult" || role === "tool_result") {
                    const id = msg.toolCallId;
                    const text = msg.content?.[0]?.text ?? "";
                    if (id)
                        toolResults.set(id, text);
                    continue;
                }
                if (role === "tool")
                    continue;
                messages.push({
                    id: entry.id || crypto.randomUUID(),
                    role,
                    content: msg.content,
                    timestamp: entry.timestamp || msg.timestamp,
                    model: msg.model || msg.modelId,
                    provider: msg.provider,
                });
            }
            catch { }
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
    for (const msg of messages) {
        if (!Array.isArray(msg.content))
            continue;
        for (const block of msg.content) {
            if (block.type === "toolCall" && block.id && toolResults.has(block.id)) {
                block.result = toolResults.get(block.id);
            }
        }
    }
    return messages;
}
async function readSessionHeader(filePath) {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let header = null;
    let firstPrompt;
    let messageCount = 0;
    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (!header) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed.type === "session") {
                        header = parsed;
                        continue;
                    }
                }
                catch { }
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
                            }
                            else if (Array.isArray(content)) {
                                const text = content.find((c) => c.type === "text");
                                if (text?.text)
                                    firstPrompt = text.text.slice(0, 120);
                            }
                        }
                    }
                    catch { }
                }
            }
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
    if (!header)
        return null;
    return {
        id: header.id,
        file: filePath,
        cwd: header.cwd || "",
        timestamp: header.timestamp || "",
        firstPrompt,
        messageCount,
    };
}

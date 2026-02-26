import { spawn } from "node:child_process";
export class RpcSession {
    proc;
    buffer = "";
    killed = false;
    opts;
    constructor(opts) {
        this.opts = opts;
        const parts = opts.piCmd.split(/\s+/);
        const cmd = parts[0];
        const args = [...parts.slice(1), "--mode", "rpc"];
        this.proc = spawn(cmd, args, {
            cwd: opts.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        this.proc.stdout.setEncoding("utf-8");
        this.proc.stderr.setEncoding("utf-8");
        this.proc.stdout.on("data", (chunk) => {
            this.buffer += chunk;
            let idx = this.buffer.indexOf("\n");
            while (idx >= 0) {
                const line = this.buffer.slice(0, idx).trim();
                this.buffer = this.buffer.slice(idx + 1);
                if (line.length > 0) {
                    try {
                        this.opts.onEvent(JSON.parse(line));
                    }
                    catch { }
                }
                idx = this.buffer.indexOf("\n");
            }
        });
        this.proc.stderr.on("data", (chunk) => {
            const msg = chunk.trim();
            if (msg)
                this.opts.onError(msg);
        });
        this.proc.on("error", (err) => this.opts.onError(err.message));
        this.proc.on("exit", (code) => this.opts.onExit(code));
        if (opts.sessionFile) {
            this.send({ type: "switch_session", sessionPath: opts.sessionFile });
        }
    }
    send(command) {
        if (this.killed || !this.proc.stdin.writable)
            return;
        this.proc.stdin.write(JSON.stringify(command) + "\n", "utf-8");
    }
    kill() {
        if (this.killed)
            return;
        this.killed = true;
        try {
            this.proc.kill("SIGTERM");
            setTimeout(() => { try {
                this.proc.kill("SIGKILL");
            }
            catch { } }, 2000);
        }
        catch { }
    }
}

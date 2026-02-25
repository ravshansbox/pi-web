import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface RpcSessionOptions {
  piCmd: string;
  cwd: string;
  sessionFile?: string;
  onEvent: (event: any) => void;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
}

export class RpcSession {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private killed = false;
  private opts: RpcSessionOptions;

  constructor(opts: RpcSessionOptions) {
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

    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const event = JSON.parse(line);
            this.opts.onEvent(event);
          } catch {
            // non-JSON line from pi, ignore
          }
        }
        idx = this.buffer.indexOf("\n");
      }
    });

    this.proc.stderr.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) this.opts.onError(msg);
    });

    this.proc.on("error", (err) => {
      this.opts.onError(err.message);
    });

    this.proc.on("exit", (code) => {
      this.opts.onExit(code);
    });

    // If a session file was provided, switch to it
    if (opts.sessionFile) {
      this.send({ type: "switch_session", sessionFile: opts.sessionFile });
    }
  }

  send(command: any): void {
    if (this.killed || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(command) + "\n", "utf-8");
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    try {
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        try { this.proc.kill("SIGKILL"); } catch {}
      }, 2000);
    } catch {}
  }
}

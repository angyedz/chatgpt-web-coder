import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { newId } from "../utils/ids.js";
import { truncate } from "../utils/text.js";
import type { HarnessEvents } from "../events.js";

export interface ExecResult {
  output: string;
  running: boolean;
  exitCode?: number;
  sessionId?: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface ExecOptions {
  workdir?: string;
  yieldTimeMs?: number;
  env?: NodeJS.ProcessEnv;
  background?: boolean;
  timeoutMs?: number;
  stdin?: string;
  displayCommand?: string;
  turnId?: string;
  signal?: AbortSignal;
}

interface ExecSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  cursor: number;
  running: boolean;
  exitCode?: number;
  exitPromise: Promise<void>;
  startedAt: number;
  truncated: boolean;
  command: string;
  workdir?: string;
  background: boolean;
  turnId?: string;
  killPromise?: Promise<boolean>;
  timedOut: boolean;
  endedAt?: number;
  timeout?: NodeJS.Timeout;
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const shell = process.env.HARNESS_SHELL || "powershell.exe";
    if (/pwsh|powershell/i.test(shell)) {
      const bootstrap =
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[Console]::OutputEncoding; ";
      return {
        file: shell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          bootstrap + command,
        ],
      };
    }
    return { file: shell, args: ["/d", "/s", "/c", command] };
  }

  const shell = process.env.HARNESS_SHELL || "/bin/bash";
  return { file: shell, args: ["-lc", command] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExecSessionManager {
  private readonly sessions = new Map<string, ExecSession>();
  private readonly maxBufferChars = 400_000;

  constructor(private readonly maxOutputChars = 30_000, private readonly events?: HarnessEvents) {}

  async run(
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    const invocation = shellInvocation(command);
    return this.runInvocation(invocation.file, invocation.args, command, options);
  }

  async runExecutable(
    file: string,
    args: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    return this.runInvocation(file, args, options.displayCommand ?? file, options);
  }

  private async runInvocation(
    file: string,
    args: string[],
    command: string,
    options: ExecOptions,
  ): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 2_147_000_000)) {
      throw new Error("Command timeout must be between 100 ms and 24 days.");
    }
    const yieldTimeMs = clamp(options.yieldTimeMs ?? (options.background ? 250 : 10_000), 250, 60_000);
    const child = spawn(file, args, {
      cwd: options.workdir,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        NO_COLOR: process.env.NO_COLOR ?? "1",
        ...options.env,
      },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const id = newId("exec");
    const session: ExecSession = {
      id,
      child,
      buffer: "",
      cursor: 0,
      running: true,
      startedAt,
      truncated: false,
      command,
      workdir: options.workdir,
      background: options.background ?? false,
      turnId: options.turnId,
      timedOut: false,
      exitPromise: Promise.resolve(),
    };

    let onAbort = () => {};
    session.exitPromise = new Promise<void>((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!session.running) return;
        session.running = false;
        session.endedAt = Date.now();
        options.signal?.removeEventListener("abort", onAbort);
        if (session.timeout) clearTimeout(session.timeout);
        session.exitCode = code ?? (signal ? 128 : -1);
        if (signal) {
          this.append(session, `\n[process terminated by ${signal}]\n`);
        }
        if (session.background) {
          this.events?.emit({ type: "notice", level: session.timedOut || session.exitCode !== 0 ? "warn" : "info", text: `Background command ${id} ${session.timedOut ? "timed out" : `finished (exit ${session.exitCode})`}. Use /job ${id} for output.` });
        }
        resolve();
      };
      child.on("error", (error) => {
        this.append(session, `\n[spawn error] ${error.message}\n`);
        finish(-1, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });

    onAbort = () => {
      void this.kill(id).then((stopped) => {
        if (!stopped && session.running) this.events?.emit({ type: "notice", level: "error", text: `Could not confirm termination of cancelled command ${id} and its child processes.` });
      });
    };

    this.append(session, "");
    this.sessions.set(id, session);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    if (options.timeoutMs !== undefined) {
      session.timeout = setTimeout(() => {
        if (!session.running) return;
        session.timedOut = true;
        this.append(session, "\n[command timed out]\n");
        void killTree(session.child).then((stopped) => {
          if (!stopped) {
            this.append(session, "[could not confirm termination of the process tree]\n");
            this.events?.emit({ type: "notice", level: "error", text: `Could not confirm that timed-out command ${id} and its child processes stopped.` });
          }
        });
      }, options.timeoutMs);
      session.timeout.unref();
    }

    child.stdout.on("data", (chunk: Buffer) => this.append(session, chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.append(session, chunk.toString("utf8")));
    child.stdin.on("error", () => {
      /* the process may close stdin early */
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin, "utf8");

    await Promise.race([session.exitPromise, sleep(yieldTimeMs)]);

    const output = this.drain(session);
    const result: ExecResult = {
      output,
      running: session.running,
      exitCode: session.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: session.timedOut,
    };
    if (session.running) {
      result.sessionId = id;
    } else {
      if (!session.background) this.sessions.delete(id);
      else result.sessionId = id;
    }
    return result;
  }

  async write(
    sessionId: string,
    chars: string,
    yieldTimeMs = 10_000,
  ): Promise<ExecResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown exec session: ${sessionId}`);
    }

    if (chars.length > 0 && session.running) {
      session.child.stdin.write(chars);
    }

    const startedAt = Date.now();
    const waitMs = clamp(yieldTimeMs, 250, 60_000);
    if (session.running) {
      await Promise.race([session.exitPromise, sleep(waitMs)]);
    }

    const output = this.drain(session);
    const result: ExecResult = {
      output,
      running: session.running,
      exitCode: session.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: session.timedOut,
    };
    if (session.running) {
      result.sessionId = sessionId;
    } else {
      if (!session.background) this.sessions.delete(sessionId);
      else result.sessionId = sessionId;
    }
    return result;
  }

  async kill(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.running) return false;
    if (session.killPromise) return session.killPromise;
    session.killPromise = (async () => {
      const stopped = await killTree(session.child);
      await Promise.race([session.exitPromise, sleep(1500)]);
      if (!stopped || session.running) {
        session.killPromise = undefined;
        return false;
      }
      if (!session.background) this.sessions.delete(sessionId);
      return true;
    })();
    return session.killPromise;
  }

  background(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.running) return false;
    session.background = true;
    return true;
  }

  list(): Array<{ id: string; running: boolean; startedAt: number; endedAt?: number; command: string; workdir?: string; background: boolean; exitCode?: number; timedOut: boolean; tail: string }> {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      running: session.running,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      command: session.command,
      workdir: session.workdir,
      background: session.background,
      exitCode: session.exitCode,
      timedOut: session.timedOut,
      tail: session.buffer.slice(-4000),
    }));
  }

  inspect(sessionId: string): ReturnType<ExecSessionManager["list"]>[number] | undefined {
    return this.list().find((session) => session.id === sessionId);
  }

  async stopForeground(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((session) => !session.background && session.running).map(async (session) => {
      if (!(await this.kill(session.id))) {
        this.events?.emit({ type: "notice", level: "error", text: `Could not confirm termination of command ${session.id} and its child processes.` });
      }
    }));
  }

  async stopTurn(turnId: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((session) => session.turnId === turnId && session.running).map(async (session) => {
      if (!(await this.kill(session.id))) {
        this.events?.emit({ type: "notice", level: "error", text: `Could not confirm termination of command ${session.id} from the cancelled turn.` });
      }
    }));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.kill(id)));
    this.sessions.clear();
  }

  private append(session: ExecSession, chunk: string): void {
    if (!chunk) return;
    session.buffer += chunk;
    if (session.buffer.length > this.maxBufferChars) {
      const drop = session.buffer.length - this.maxBufferChars;
      session.buffer = session.buffer.slice(drop);
      session.cursor = Math.max(0, session.cursor - drop);
      session.truncated = true;
    }
  }

  private drain(session: ExecSession): string {
    const chunk = session.buffer.slice(session.cursor);
    session.cursor = session.buffer.length;
    const prefix = session.truncated && chunk.length > 0
      ? "[earlier output was truncated]\n"
      : "";
    session.truncated = false;
    return truncate(prefix + chunk, this.maxOutputChars);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function killTree(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  if (child.pid === undefined) return false;
  if (process.platform === "win32") {
    const stopped = await new Promise<boolean>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("close", (code) => resolve(code === 0));
      killer.on("error", () => resolve(false));
    });
    if (!stopped) child.kill("SIGKILL");
    return stopped;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch {
    child.kill("SIGKILL");
    return false;
  }
}

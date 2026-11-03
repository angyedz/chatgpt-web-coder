import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, HarnessEvent, PlanStep, ToolCallView } from "../types.js";
import type { TimerInfo } from "./timers.js";
import { cleanAssistantHistory } from "../browser/response-text.js";
import { harnessHome } from "../utils/paths.js";
import type { Goal } from "./goals.js";
import type { Attachment } from "./attachments.js";

export interface SessionJob {
  id: string;
  kind: "process" | "task";
  status: string;
  description: string;
  output?: string;
}

export interface SavedSession {
  version: 1;
  id: string;
  workspace: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  tools: ToolCallView[];
  plan: PlanStep[];
  goal?: Goal;
  attachments?: Attachment[];
  jobs: SessionJob[];
  timers: TimerInfo[];
  previousRuntime?: { jobs: SessionJob[]; timers: TimerInfo[]; savedAt: number };
  contextSummary: string;
  order: number;
}

function freshSession(workspace: string): SavedSession {
  const now = Date.now();
  return { version: 1, id: randomUUID(), workspace, title: "New session", createdAt: now, updatedAt: now, messages: [], tools: [], plan: [], jobs: [], timers: [], contextSummary: "", order: 0 };
}

export class SessionStore {
  private readonly directory: string;
  private current: SavedSession;
  private timer?: NodeJS.Timeout;
  private writes: Promise<void> = Promise.resolve();
  private pendingError?: Error;

  constructor(private readonly workspace: string, private readonly onError: (error: Error) => void) {
    const canonical = path.resolve(workspace);
    const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex").slice(0, 20);
    this.directory = path.join(harnessHome(), "sessions", key);
    this.current = freshSession(canonical);
  }

  /** Discover every saved chat, across all project folders, without changing the active session. */
  static async listAll(): Promise<SavedSession[]> {
    const root = path.join(harnessHome(), "sessions");
    let folders;
    try { folders = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sessions: SavedSession[] = [];
    for (const folder of folders) {
      if (!folder.isDirectory() || !/^[a-f0-9]{20}$/.test(folder.name)) continue;
      const directory = path.join(root, folder.name);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}\\.json$/i.test(entry.name)) continue;
        try {
          const data: unknown = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
          if (!data || typeof data !== "object") continue;
          const session = data as SavedSession;
          if (session.version !== 1 || session.id + ".json" !== entry.name || typeof session.workspace !== "string" || !path.isAbsolute(session.workspace) || !Array.isArray(session.messages) || !Array.isArray(session.tools) || !Array.isArray(session.plan)) continue;
          const canonical = path.resolve(session.workspace);
          const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex").slice(0, 20);
          if (key !== folder.name) continue;
          sessions.push(session);
        } catch { /* Ignore corrupted historical files; never make the bot select them. */ }
      }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get snapshot(): SavedSession { return structuredClone(this.current); }
  get id(): string { return this.current.id; }

  async initialize(): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let id: string | undefined;
    try { id = (await readFile(path.join(this.directory, "active"), "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (id) {
      this.current = await this.read(id);
      this.markInterrupted();
      await this.flush();
      return true;
    }
    await this.persistCurrent();
    return false;
  }

  async list(): Promise<SavedSession[]> {
    let entries: string[];
    try { entries = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: SavedSession[] = [];
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(entry)) continue;
      try { result.push(await this.read(entry.slice(0, -5))); }
      catch (error) { this.onError(new Error(`Cannot read saved session ${entry}: ${error instanceof Error ? error.message : String(error)}`)); }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async open(id: string): Promise<void> {
    const sessions = await this.list();
    const matches = sessions.filter((session) => session.id === id || session.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? "Session ID is ambiguous." : "Session not found.");
    await this.flush();
    const previous = this.current;
    this.current = matches[0]!;
    this.markInterrupted();
    try { await this.persistCurrent(); }
    catch (error) { this.current = previous; throw error; }
  }

  async create(): Promise<void> {
    await this.flush();
    const previous = this.current;
    this.current = freshSession(path.resolve(this.workspace));
    try { await this.persistCurrent(); }
    catch (error) { this.current = previous; throw error; }
  }

  rename(title: string): void {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 120) throw new Error("Session title must be 1–120 characters.");
    this.current.title = trimmed;
    this.changed();
  }

  record(event: HarnessEvent): void {
    const session = this.current;
    const message = (id: string) => session.messages.find((item) => item.id === id);
    switch (event.type) {
      case "user-message":
      case "system-message":
        session.messages.push({ id: event.id, role: event.type === "user-message" ? "user" : "system", text: event.text, createdAt: Date.now(), order: ++session.order, ...(event.type === "user-message" && event.channel ? { channel: event.channel } : {}) });
        if (event.type === "user-message" && session.title === "New session") session.title = event.text.replace(/\s+/g, " ").slice(0, 80);
        break;
      case "assistant-start":
        session.messages.push({ id: event.id, role: "assistant", text: "", createdAt: Date.now(), order: ++session.order, streaming: true, ...(event.channel ? { channel: event.channel } : {}) });
        break;
      case "assistant-delta":
      case "assistant-done": {
        let item = message(event.id);
        if (!item) {
          item = { id: event.id, role: "assistant", text: "", createdAt: Date.now(), order: ++session.order, ...(event.channel ? { channel: event.channel } : {}) };
          session.messages.push(item);
        }
        item.text = event.text;
        item.streaming = event.type === "assistant-delta";
        if (event.type === "assistant-done") item.interrupted = Boolean(event.error);
        break;
      }
      case "tool-start":
        session.tools.push({ ...event.call, order: ++session.order });
        break;
      case "tool-end": {
        const index = session.tools.findIndex((item) => item.id === event.call.id);
        if (index < 0) return;
        session.tools[index] = { ...event.call, order: session.tools[index]!.order };
        break;
      }
      case "plan":
        session.plan = structuredClone(event.steps);
        break;
      case "goal":
        session.goal = event.goal ? structuredClone(event.goal) : undefined;
        break;
      case "attachments":
        session.attachments = structuredClone(event.attachments);
        break;
      case "turn-end":
        for (const item of session.messages) if (item.streaming && item.channel !== "btw") { item.streaming = false; item.interrupted = !event.ok; }
        break;
      default:
        return;
    }
    this.changed(event.type === "assistant-delta" ? 2000 : 500);
  }

  setRuntime(jobs: SessionJob[], timers: TimerInfo[]): void {
    this.current.jobs = structuredClone(jobs);
    this.current.timers = structuredClone(timers);
    this.changed();
  }

  setSummary(summary: string): void { this.current.contextSummary = summary; this.changed(); }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.enqueueSnapshot(); }
    await this.writes;
    if (this.pendingError) { const error = this.pendingError; this.pendingError = undefined; throw error; }
  }

  private changed(delayMs = 500): void {
    this.current.updatedAt = Date.now();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.enqueueSnapshot(); }, delayMs);
      this.timer.unref();
    }
  }

  private enqueueSnapshot(): void {
    const snapshot = this.snapshot;
    this.writes = this.writes.then(() => this.atomicWrite(`${snapshot.id}.json`, JSON.stringify(snapshot))).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.pendingError = failure;
      this.onError(failure);
    });
  }

  private async persistCurrent(): Promise<void> {
    this.enqueueSnapshot();
    await this.flush();
    await this.atomicWrite("active", this.current.id);
  }

  private async atomicWrite(name: string, value: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, name);
    const temp = path.join(this.directory, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, value, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") await chmod(temp, 0o600);
      await rename(temp, target);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  private async read(id: string): Promise<SavedSession> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid session ID.");
    const data: unknown = JSON.parse(await readFile(path.join(this.directory, `${id}.json`), "utf8"));
    if (!data || typeof data !== "object") throw new Error("Invalid session file.");
    const value = data as SavedSession;
    const sameWorkspace = process.platform === "win32"
      ? path.resolve(value.workspace ?? "").toLowerCase() === path.resolve(this.workspace).toLowerCase()
      : path.resolve(value.workspace ?? "") === path.resolve(this.workspace);
    if (value.version !== 1 || value.id !== id || !sameWorkspace || !Array.isArray(value.messages) || !Array.isArray(value.tools) || !Array.isArray(value.plan) || !Array.isArray(value.jobs) || !Array.isArray(value.timers) || typeof value.order !== "number" || typeof value.contextSummary !== "string") throw new Error("Invalid or incompatible session file.");
    return value;
  }

  private markInterrupted(): void {
    if (this.current.goal?.status === "active") this.current.goal = { ...this.current.goal, status: "paused", detail: "Harness stopped; use /goal resume to continue after reviewing the session.", updatedAt: Date.now() };
    for (const message of this.current.messages) if (message.streaming) { message.streaming = false; message.interrupted = true; }
    for (const tool of this.current.tools) if (tool.status === "running") { tool.status = "error"; tool.error = "Harness stopped before the result was recorded; outcome is unknown."; }
    if (this.current.jobs.length || this.current.timers.length) {
      this.current.previousRuntime = { jobs: this.current.jobs, timers: this.current.timers, savedAt: this.current.updatedAt };
      this.current.jobs = [];
      this.current.timers = [];
    }
    this.changed();
  }
}

export function sessionHandoff(session: SavedSession): string {
  const orderedMessages = session.messages.filter((message) => message.channel !== "btw");
  const completeMessageOrder = orderedMessages.every((message) => Number.isFinite(message.order));
  orderedMessages.sort((a, b) => completeMessageOrder ? a.order! - b.order! : a.createdAt - b.createdAt);
  const cleaned = cleanAssistantHistory(orderedMessages);
  const items = [
    ...orderedMessages.filter((message) => message.role !== "system").map((message) => ({ order: message.order, time: message.createdAt, text: message.role === "assistant" ? cleaned.get(message.id) ?? "" : message.text, role: message.role, interrupted: message.interrupted })).filter((message) => message.text.trim()).map((message) => ({ order: message.order, time: message.time, text: `${message.role}${message.interrupted ? " (interrupted)" : ""}: ${message.text.slice(0, 5000)}` })),
    ...session.tools.map((tool) => ({ order: tool.order, time: tool.startedAt, text: `tool ${tool.name} (${tool.status})\narguments: ${JSON.stringify(tool.args ?? {}).slice(0, 800)}\nresult: ${String(tool.output ?? tool.error ?? "").slice(0, 1200)}` })),
  ];
  const completeOrder = items.every((item) => Number.isFinite(item.order));
  items.sort((a, b) => completeOrder ? a.order! - b.order! : a.time - b.time);
  const history = items.slice(-40).map((item) => item.text).join("\n\n").slice(-36_000);
  const goal = session.goal
    ? `status: ${session.goal.status}\nobjective (exact): ${session.goal.objective}${session.goal.detail ? `\nlast status detail: ${session.goal.detail}` : ""}`
    : "(none)";
  const plan = session.plan.map((step) => `${step.status}: ${step.step}`).join("\n");
  const jobs = (session.previousRuntime?.jobs ?? session.jobs).map((job) => `${job.id} ${job.kind} ${job.status}: ${job.description}`).join("\n");
  const timers = (session.previousRuntime?.timers ?? session.timers).map((timer) => `${timer.id}: ${timer.label}, due ${new Date(timer.dueAt).toISOString()}`).join("\n");
  return `Restored local session. The previous Web conversation is unavailable; this is a bounded handoff, not a complete transcript. Treat past tool results as historical and inspect the current workspace before relying on them. Any previously running action has an unknown outcome; do not restart it automatically. Previously scheduled timers and background processes are not automatically restored.\n\nLast known user goal (authoritative harness state):\n${goal}\n\n${session.contextSummary ? `Earlier compacted memory:\n${session.contextSummary.slice(-16_000)}\n\n` : ""}Last known plan:\n${plan || "(none)"}\n\nLast recorded jobs (historical):\n${jobs || "(none)"}\n\nLast recorded timers (historical):\n${timers || "(none)"}\n\nRecent transcript:\n${history || "(empty)"}`;
}

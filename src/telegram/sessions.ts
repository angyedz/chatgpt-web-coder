import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config.js";
import { ChatGptBrowser } from "../browser/chatgpt.js";
import { HarnessEvents } from "../events.js";
import { createRuntime, type Runtime } from "../runtime/context.js";
import { SessionStore, sessionHandoff, type SavedSession } from "../runtime/sessions.js";
import type { HarnessEvent, TurnPhase } from "../types.js";
import { newId } from "../utils/ids.js";
import type { McpHost } from "../mcp/server.js";

export interface TelegramSessionChoice {
  id: string;
  title: string;
  workspace: string;
  updatedAt: number;
}

interface SessionWorker {
  browser: ChatGptBrowser;
  store: SessionStore;
  events: HarnessEvents;
  unsubscribe: () => void;
  hasSent: boolean;
  busy: boolean;
  phase: TurnPhase;
  controller?: AbortController;
  runtime?: Runtime;
}

/**
 * Telegram owns a selection, not the foreground harness session.
 * Remote sessions use their own background tab, persisted session store and MCP turn context.
 * Nothing in this router changes the root workspace or foreground ChatGPT tab.
 */
export class TelegramSessionBridge {
  private selectedId: string | undefined;
  private selectedChoice?: TelegramSessionChoice;
  private readonly workers = new Map<string, SessionWorker>();
  private readonly approvals = new Map<string, Runtime>();
  private sending = new Set<string>();

  constructor(
    private readonly config: HarnessConfig,
    private readonly rootBrowser: ChatGptBrowser,
    private readonly mcp: McpHost,
    private readonly rootSession: () => SavedSession,
    private readonly rootBusy: () => boolean,
    private readonly rootPhase: () => TurnPhase,
    private readonly submitRoot: (text: string) => boolean,
    private readonly cancelRoot: () => void,
    private readonly emit: (event: HarnessEvent) => void,
    private readonly rootCommand: (text: string) => Promise<string> = async () => {
      throw new Error("The harness command dispatcher is unavailable.");
    },
  ) {
    this.selectedId = config.telegram.selectedSessionId || undefined;
  }

  get selected(): TelegramSessionChoice {
    const root = this.rootSession();
    const worker = this.selectedId ? this.workers.get(this.selectedId) : undefined;
    if (worker) return this.describe(worker.store.snapshot);
    return this.selectedChoice ?? this.describe(root);
  }

  get isRootSelected(): boolean {
    return !this.selectedId || this.selectedId === this.rootSession().id;
  }

  get busy(): boolean {
    return this.isRootSelected ? this.rootBusy() : this.sending.has(this.selectedId!);
  }

  get phase(): TurnPhase {
    return this.isRootSelected ? this.rootPhase() : this.workers.get(this.selectedId!)?.phase ?? "idle";
  }

  private describe(session: SavedSession): TelegramSessionChoice {
    return { id: session.id, title: session.title, workspace: session.workspace, updatedAt: session.updatedAt };
  }

  async list(): Promise<TelegramSessionChoice[]> {
    const all = await SessionStore.listAll();
    const root = this.rootSession();
    if (!all.some((item) => item.id === root.id)) all.push(root);
    return all.sort((a, b) => b.updatedAt - a.updatedAt).map((session) => this.describe(session));
  }

  resetSelection(): void {
    this.selectedId = undefined;
    this.selectedChoice = undefined;
  }

  async choose(id: string): Promise<TelegramSessionChoice> {
    if (this.busy) throw new Error("Stop the current Telegram task before switching sessions.");
    const options = await this.list();
    const matches = options.filter((item) => item.id === id || item.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? "Session ID is ambiguous." : "Saved session not found.");
    const choice = matches[0]!;
    const info = await stat(choice.workspace);
    if (!info.isDirectory()) throw new Error("The session's project folder no longer exists.");
    this.selectedId = choice.id;
    this.selectedChoice = choice;
    return choice;
  }

  async create(folder: string): Promise<TelegramSessionChoice> {
    if (this.busy) throw new Error("Stop the current Telegram task before creating a session.");
    const createFolder = /^--(?:create|mkdir)\s+/i.test(folder);
    const input = folder.replace(/^--(?:create|mkdir)\s+/i, "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
    if (!input || !path.isAbsolute(input)) throw new Error("Use an absolute project path, for example /new C:\\Projects\\App or /new --create C:\\Projects\\App.");
    const requested = path.resolve(input);
    if (createFolder) await mkdir(requested, { recursive: true });
    const info = await stat(requested);
    if (!info.isDirectory()) throw new Error("Choose an existing project directory, or use /new --create <absolute path>.");
    const workspace = await realpath(requested);
    const store = new SessionStore(workspace, (error) => this.emit({ type: "notice", level: "error", text: `Telegram session storage: ${error.message}` }));
    const created = await store.createDetached();
    this.selectedId = created.id;
    this.selectedChoice = this.describe(created);
    return this.selectedChoice;
  }

  async folderList(): Promise<string[]> {
    return [...new Set((await this.list()).map((item) => item.workspace))].sort();
  }

  /** Telegram commands use the same harness dispatcher. Only local session
   * operations are scoped to the selected detached session; machine-wide
   * commands (updates, model, swarm, connection settings) remain global.
   */
  async command(text: string): Promise<string> {
    const parsed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!parsed) throw new Error("Expected a slash command.");
    const name = parsed[1]!.toLowerCase();
    const argument = (parsed[2] ?? "").trim();
    if (!this.isRootSelected) {
      if (name === "status") {
        const session = await this.selectedSavedSession();
        return [
          "Selected Telegram session: " + session.title,
          "ID: " + session.id,
          "Workspace: " + session.workspace,
          "Phase: " + this.phase,
          "Running: " + (this.busy ? "yes" : "no"),
          "Messages: " + session.messages.length,
          "Tools: " + session.tools.length,
          "Goal: " + (session.goal ? session.goal.status + " — " + session.goal.objective : "none"),
        ].join("\n");
      }
      if (name === "session") {
        const [action = "info", ...parts] = argument.split(/\s+/);
        const value = parts.join(" ").trim();
        if (action === "rename") {
          if (this.busy) throw new Error("Wait until the selected session is idle before renaming it.");
          const store = await this.selectedStore();
          store.rename(value);
          await store.flush();
          this.selectedChoice = this.describe(store.snapshot);
          return "Renamed selected session to: " + store.snapshot.title;
        }
        if (action === "info") {
          const session = await this.selectedSavedSession();
          return "Session " + session.id + "\nTitle: " + session.title + "\nWorkspace: " + session.workspace + "\nMessages: " + session.messages.length + "\nTools: " + session.tools.length;
        }
        if (action === "job") {
          const session = await this.selectedSavedSession();
          const job = [...(session.previousRuntime?.jobs ?? []), ...session.jobs].find((item) => item.id === value);
          if (!job) throw new Error("Recorded job not found. Try /session info.");
          return "Recorded " + job.kind + " " + job.id + " · " + job.status + "\n" + job.description + "\n\n" + (job.output || "(no saved output)");
        }
      }
      if (name === "goal") {
        const store = await this.selectedStore();
        const old = store.snapshot.goal;
        const lower = argument.toLowerCase();
        if (!argument || lower === "status") {
          return old ? "Selected session goal: " + old.status + "\n" + old.objective + (old.detail ? "\n" + old.detail : "") : "No goal in the selected session.";
        }
        if (lower === "pause" || lower === "cancel") {
          if (!old) throw new Error("There is no goal in this session.");
          if (this.busy) throw new Error("Use /stop to interrupt the running Telegram turn first.");
          store.record({ type: "goal", goal: { ...old, status: lower === "pause" ? "paused" : "cancelled", detail: "Changed from Telegram by the owner.", updatedAt: Date.now() } });
          await store.flush();
          return "Selected session goal " + (lower === "pause" ? "paused" : "cancelled") + ".";
        }
        if (this.busy) throw new Error("A task in the selected session is already running.");
        if (!this.rootBrowser.isOpen) throw new Error("The ChatGPT browser is not connected; the goal was not started.");
        let objective = argument;
        if (lower === "resume" || lower.startsWith("resume ")) {
          if (!old || !["paused", "blocked"].includes(old.status)) throw new Error("No paused or blocked goal to resume.");
          objective = old.objective;
          store.record({ type: "goal", goal: { ...old, status: "active", detail: undefined, updatedAt: Date.now() } });
        } else {
          const now = Date.now();
          store.record({ type: "goal", goal: { objective, status: "active", createdAt: now, updatedAt: now } });
        }
        await store.flush();
        const id = this.selectedId!;
        this.sending.add(id);
        try {
          await this.run(id, "Work toward this goal in the selected project folder: " + objective + ". Use the goal tools to mark completion only after verifying it.", true);
        } finally {
          this.sending.delete(id);
        }
        const final = (await this.selectedSavedSession()).goal;
        return final ? "Goal: " + final.status + "\n" + final.objective + (final.detail ? "\n" + final.detail : "") : "Goal turn finished.";
      }
      if (name === "attachments") {
        const items = (await this.selectedSavedSession()).attachments ?? [];
        return items.length ? "Selected session attachments:\n" + items.map((item) => item.id + " · " + item.name).join("\n") : "No attachments in this Telegram session.";
      }
      if (name === "attach" || name === "detach" || name === "compact") {
        throw new Error("/" + name + " is session-scoped and cannot be run against the foreground harness while a different Telegram session is selected. Select the local session first.");
      }
    }
    const response = await this.rootCommand(text);
    return this.isRootSelected ? response : "[Main harness / global command — not the selected project folder]\n\n" + response;
  }

  private async selectedStore(): Promise<SessionStore> {
    if (!this.selectedId) throw new Error("No selected Telegram session.");
    const worker = this.workers.get(this.selectedId);
    if (worker) return worker.store;
    const session = await this.list();
    const choice = session.find((item) => item.id === this.selectedId);
    if (!choice) throw new Error("Selected session no longer exists.");
    const store = new SessionStore(choice.workspace, (error) => this.emit({ type: "notice", level: "error", text: error.message }));
    await store.loadDetached(choice.id);
    return store;
  }

  private async selectedSavedSession(): Promise<SavedSession> {
    return (await this.selectedStore()).snapshot;
  }

  submit(text: string): boolean {
    if (!text.trim() || this.busy) return false;
    if (this.isRootSelected) return this.submitRoot(text);
    if (!this.selectedId) return false;
    if (this.sending.has(this.selectedId)) return false;
    const id = this.selectedId;
    this.sending.add(id);
    void this.run(id, text).catch((error: unknown) => {
      const turnId = newId("telegram-error");
      const details = error instanceof Error ? error.message : String(error);
      this.emit({ type: "turn-start", turnId });
      this.emit({ type: "assistant-done", id: newId("telegram-error"), text: `Cannot run selected session: ${details}`, error: details, channel: "telegram" });
      this.emit({ type: "turn-end", turnId, ok: false });
      this.emit({ type: "notice", level: "error", text: `Telegram session: ${details}` });
    }).finally(() => this.sending.delete(id));
    return true;
  }

  cancel(): void {
    if (this.isRootSelected) { this.cancelRoot(); return; }
    const worker = this.selectedId ? this.workers.get(this.selectedId) : undefined;
    if (worker?.runtime?.goal.current?.status === "active") {
      worker.runtime.goal.pauseByUser("Paused from Telegram by the owner.");
    }
    worker?.controller?.abort();
    if (worker) {
      worker.runtime?.approvals.denyAll();
      void worker.browser.stop().catch(() => undefined);
    }
  }

  approve(id: string, allowed: boolean): boolean {
    const runtime = this.approvals.get(id);
    if (!runtime) return false;
    runtime.approvals.respond(id, allowed);
    this.approvals.delete(id);
    return true;
  }

  async shutdown(): Promise<void> {
    for (const worker of this.workers.values()) {
      worker.controller?.abort();
      worker.runtime?.approvals.denyAll();
    }
    await Promise.allSettled([...this.workers.values()].map(async (worker) => {
      await worker.browser.closeSideChat().catch(() => undefined);
      await worker.store.flush().catch(() => undefined);
      worker.unsubscribe();
    }));
    this.workers.clear();
    this.approvals.clear();
  }

  private async workerFor(choice: TelegramSessionChoice): Promise<SessionWorker> {
    const existing = this.workers.get(choice.id);
    if (existing?.browser.isOpen) return existing;
    if (existing) {
      await existing.browser.closeSideChat().catch(() => undefined);
      existing.unsubscribe();
      this.workers.delete(choice.id);
    }
    if (!this.rootBrowser.isOpen) throw new Error("The main browser is not connected yet.");
    const events = new HarnessEvents();
    const store = new SessionStore(choice.workspace, (error) => this.emit({ type: "notice", level: "error", text: error.message }));
    await store.loadDetached(choice.id);
    const browser = await this.rootBrowser.openSideChat(events, { attachConnector: true });
    browser.setResponseChannel("telegram");
    const worker: SessionWorker = {
      browser, events, store, hasSent: false, busy: false, phase: "idle",
      unsubscribe: events.on((event) => {
        store.record(event);
        if (event.type === "phase") worker.phase = event.phase;
        if (event.type === "approval") {
          if (worker.runtime) this.approvals.set(event.request.id, worker.runtime);
        }
        if (event.type === "approval-resolved") this.approvals.delete(event.id);
        this.emit(event);
      }),
    };
    this.workers.set(choice.id, worker);
    return worker;
  }

  private async run(id: string, message: string, goalMode = false): Promise<void> {
    const choice = (await this.list()).find((item) => item.id === id);
    if (!choice) throw new Error("Saved Telegram session is missing.");
    let worker: SessionWorker | undefined;
    let registered = false;
    let turnId = newId("turn");
    try {
      worker = await this.workerFor(choice);
      if (worker.busy) throw new Error("The selected session is already running.");
      worker.busy = true;
      const controller = new AbortController();
      worker.controller = controller;
      const config: HarnessConfig = { ...this.config, workspace: choice.workspace, browser: { ...this.config.browser } };
      const runtime = createRuntime(config, worker.events, turnId);
      worker.runtime = runtime;
      runtime.context.turnSignal = controller.signal;
      runtime.context.browser = worker.browser;
      runtime.context.beforeToolStart = () => worker!.browser.snapshotBeforeTool();
      runtime.goal.restore(worker.store.snapshot.goal);
      runtime.plan.update(worker.store.snapshot.plan);
      this.mcp.registerTurnContext(turnId, runtime.context);
      registered = true;
      worker.events.emit({ type: "turn-start", turnId });
      worker.events.emit({ type: "phase", phase: "sending" });
      const history = worker.hasSent ? "" : sessionHandoff(worker.store.snapshot);
      worker.events.emit({ type: "user-message", id: newId("telegram-user"), text: message, channel: "telegram" });
      let ok = false;
      try {
        const prompt = worker.hasSent ? message : `${history}\n\nNEW USER MESSAGE FROM TELEGRAM:\n${message}`;
        const answer = await worker.browser.send(prompt, controller.signal, { turnId, continueChat: worker.hasSent });
        worker.hasSent = true;
        controller.signal.throwIfAborted();
        if (goalMode) {
          let remaining = 3;
          while (runtime.goal.current?.status === "active" && remaining-- > 0) {
            await worker.browser.send(
              "Continue the active goal in this project workspace. Do not claim completion without evidence. Call update_goal with complete and evidence if verified, or blocked with the obstacle when you cannot proceed.",
              controller.signal, { turnId, continueChat: true },
            );
            controller.signal.throwIfAborted();
          }
          if (runtime.goal.current?.status === "active") {
            runtime.goal.setStatus("blocked", "Three follow-up turns finished without completing the goal. Use /goal resume to continue.");
          }
        }
        ok = true;
        if (!answer.trim()) worker.events.emit({ type: "assistant-done", id: newId("tg-assistant"), text: "(No text response)", channel: "telegram" });
      } catch (error) {
        if (runtime.goal.current?.status === "active") {
          runtime.goal.setStatus("blocked", "Telegram turn failed or was interrupted; review it and use /goal resume.");
        }
        worker.events.emit({ type: "assistant-done", id: newId("tg-error"), text: error instanceof Error ? error.message : String(error), error: "Telegram session turn failed", channel: "telegram" });
      } finally {
        worker.events.emit({ type: "turn-end", turnId, ok });
        worker.events.emit({ type: "phase", phase: "idle" });
      }
    } finally {
      if (registered) this.mcp.unregisterTurnContext(turnId);
      if (worker) {
        const runtime = worker.runtime;
        if (runtime) {
          runtime.approvals.denyAll();
          for (const [approvalId, owner] of this.approvals) if (owner === runtime) this.approvals.delete(approvalId);
          await runtime.exec.stopTurn(turnId).catch(() => undefined);
          runtime.timers.dispose();
          await runtime.externalMcp.close().catch(() => undefined);
          await runtime.exec.dispose().catch(() => undefined);
        }
        worker.controller = undefined;
        worker.runtime = undefined;
        worker.busy = false;
        await worker.store.flush().catch(() => undefined);
      }
    }
  }
}

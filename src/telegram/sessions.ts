import { mkdir, realpath, stat } from "node:fs/promises";
import { SubagentManager } from "../agent/subagents.js";
import { AttachmentStore } from "../runtime/attachments.js";
import { discoverSkills } from "../runtime/skills.js";
import { formatInstructions, projectInstructions } from "../runtime/instructions.js";
import path from "node:path";
import type { HarnessConfig } from "../config.js";
import { ChatGptBrowser } from "../browser/chatgpt.js";
import { HarnessEvents } from "../events.js";
import { createRuntime, type Runtime } from "../runtime/context.js";
import { SessionStore, sessionHandoff, type SavedSession } from "../runtime/sessions.js";
import { captureRemoteRuntime, runRemoteRuntimeCommand } from "./runtime-commands.js";
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
  pickerChoices?: { model: string[]; effort: string[] };
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
  private readonly detachedSwarms = new Map<string, SubagentManager>();

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
      if (name === "help" || name === "?") {
        return "Telegram session commands: /status · /sessions · /switch <id> · /new <absolute folder> · /new --create <absolute folder> · /session info|rename <title>|job <id> · /goal <objective>|status|resume|pause|cancel · /attach <path> · /attach folder <path> · /attachments · /detach <id>|all · /agents [path] · /skills · /compact · /swarm start <1-5> <objective>|status|inspect|chat|message|results|history|report|stop. Machine-wide commands (such as /update, /mcp, /approval and /doctor) act on the main harness. Other commands must not silently act on the main project.";
      }
      if (name === "swarm") return this.swarmCommand(argument);
      if (name === "model" || name === "effort") return this.pickerCommand(name, argument);
      if (["timer", "timers", "jobs", "job"].includes(name)) {
        const choice = (await this.list()).find((item) => item.id === this.selectedId);
        if (!choice) throw new Error("Selected session not found.");
        const worker = await this.workerFor(choice);
        return runRemoteRuntimeCommand(name, argument, worker.runtime!, worker.store);
      }
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
        throw new Error("Unknown selected session command. Use /session info|rename <title>|job <id>, or /sessions to switch.");
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
      if (name === "attach" || name === "attachments" || name === "detach") {
        if (this.busy) throw new Error("The selected session must be idle before changing attachments.");
        const store = await this.selectedStore();
        const events = new HarnessEvents();
        events.on((event) => { if (event.type === "attachments") store.record(event); });
        const attachments = new AttachmentStore(events);
        attachments.restore(store.id, store.snapshot.attachments);
        if (name === "attach") {
          if (!argument || argument === "clipboard" || argument === "folder") {
            throw new Error("Telegram has no local file picker. Use /attach <path> or /attach folder <path>.");
          }
          const target = argument.startsWith("folder ") ? argument.slice("folder ".length) : argument;
          const item = await attachments.attach(target, store.snapshot.workspace);
          await store.flush();
          return "Attached to selected session: " + item.id + " · " + item.name + " (" + item.kind + ").";
        }
        if (name === "detach") {
          if (argument === "all") attachments.clearPending();
          else if (!argument || !attachments.remove(argument)) throw new Error("Usage: /detach <id>|all");
          await store.flush();
          return "Selected session attachment removed.";
        }
        const items = attachments.current;
        return items.length ? "Selected session attachments:\n" + items.map((item) => item.id + " · " + item.kind + " · " + item.name + (item.pending ? " · pending" : "")).join("\n") : "No attachments in this Telegram session.";
      }
      if (name === "agents") {
        const session = await this.selectedSavedSession();
        const files = await projectInstructions(session.workspace, argument || ".");
        return files.length ? formatInstructions(files) : "No applicable AGENTS.md for this selected workspace.";
      }
      if (name === "skills") {
        const session = await this.selectedSavedSession();
        const skills = await discoverSkills({ ...this.config, workspace: session.workspace });
        return skills.length ? skills.map((item) => item.name + " · " + item.description).join("\n") : "No skills in selected workspace.";
      }
      if (name === "compact") {
        if (this.busy) throw new Error("Wait until the selected session is idle to compact its context.");
        const store = await this.selectedStore();
        store.setSummary(sessionHandoff(store.snapshot));
        await store.flush();
        const worker = this.selectedId ? this.workers.get(this.selectedId) : undefined;
        if (worker?.browser.isOpen) await worker.browser.newChat();
        if (worker) worker.hasSent = false;
        return "Selected Telegram session will continue in a fresh browser chat with a bounded saved-session handoff. The original local harness chat is unchanged.";
      }
      const machineWide = new Set(["update", "mcp", "approval", "yolo", "tools", "doctor", "connect", "telegram", "login", "tunnel", "searxng", "quit", "exit"]);
      if (!machineWide.has(name)) throw new Error(`/${name} is not implemented for the selected Telegram session. It was NOT run in the main project. Use /help to see supported commands.`);
    }
    const response = await this.rootCommand(text);
    return this.isRootSelected ? response : "[Main harness / global command — not the selected project folder]\n\n" + response;
  }

  private async pickerCommand(kind: "model" | "effort", argument: string): Promise<string> {
    if (this.busy) throw new Error("Wait until the selected session is idle.");
    if (!this.selectedId) throw new Error("No session selected.");
    const choice = (await this.list()).find((item) => item.id === this.selectedId);
    if (!choice) throw new Error("Selected session not found.");
    const worker = await this.workerFor(choice);
    const choices = worker.pickerChoices ??= { model: [], effort: [] };
    const key = kind === "model" ? "modelLabel" : "effortLabel";
    if (argument.toLowerCase() === "default") {
      worker.browser.setPickerPreference(kind, "");
      worker.store.setBrowserOverrides({ [key]: "" });
      choices[kind] = [];
      await worker.store.flush();
      return `Selected session ${kind}: ChatGPT default (override cleared).`;
    }
    if (!argument || argument.toLowerCase() === "list") {
      const result = await worker.browser.picker(kind);
      choices[kind] = result.choices;
      return `Available ${kind}s in selected session:\n` + result.choices.map((label, i) => `${i + 1}. ${label}`).join("\n") + `\nUse /${kind} <number>|<name>|default.`;
    }
    const requested = /^\d+$/.test(argument) ? choices[kind][Number(argument) - 1] : argument;
    if (!requested) throw new Error(`Run /${kind} to see available choices before using a number.`);
    const selection = await worker.browser.picker(kind, requested);
    if (!selection.selected) throw new Error("ChatGPT did not confirm the selection.");
    worker.browser.setPickerPreference(kind, selection.selected);
    if (kind === "model") {
      worker.browser.setPickerPreference("effort", "");
      worker.store.setBrowserOverrides({ modelLabel: selection.selected, effortLabel: "" });
      choices.effort = [];
    } else worker.store.setBrowserOverrides({ effortLabel: selection.selected });
    await worker.store.flush();
    return `Selected session ${kind}: ${selection.selected}` + (selection.confirmed === undefined ? " (Check the browser: confirmation unavailable.)" : "");
  }

  private async swarmCommand(argument: string): Promise<string> {
    const id = this.selectedId;
    if (!id) throw new Error("Select a Telegram session first.");
    let manager = this.detachedSwarms.get(id);
    if (!manager) {
      const choice = (await this.list()).find((item) => item.id === id);
      if (!choice) throw new Error("Selected session no longer exists.");
      const events = new HarnessEvents();
      events.on((event) => this.emit(event));
      manager = new SubagentManager({ ...this.config, workspace: choice.workspace, browser: { ...this.config.browser } }, this.rootBrowser, this.mcp, events);
      this.detachedSwarms.set(id, manager);
    }
    const action = argument.trim();
    if (!action || action.toLowerCase() === "status") {
      const agents = manager.snapshots;
      return agents.length ? "Selected project subagents:\n" + agents.map((a) => `#${a.id} · ${a.role} · ${a.status} · ${a.toolCount} tools\n${a.workspace}\n${a.activity ?? "idle"}`).join("\n\n") : "No subagents for the selected project. Use /swarm start <1-5> <objective>.";
    }
    if (action.toLowerCase() === "history") {
      const reports = await manager.history();
      return reports.length ? reports.map((r) => `${r.id} · ${r.objective.slice(0, 130)} · ${new Date(r.savedAt).toLocaleString()}`).join("\n") : "No saved subagent reports.";
    }
    const report = /^report\s+([a-z0-9-]+)$/i.exec(action);
    if (report) {
      const item = await manager.report(report[1]!);
      return `Swarm report ${item.id}\n${item.objective}\n\n` + item.agents.map((a) => `#${a.id} [${a.status}] ${a.role}\n${a.error ?? a.summary ?? a.preview ?? "No result"}`).join("\n\n");
    }
    const start = /^start\s+([1-5])\s+([\s\S]+)$/i.exec(action);
    if (start) {
      await manager.start(Number(start[1]), start[2]!);
      return `Started ${start[1]} subagents for selected workspace. Use /swarm status or /swarm results to inspect their progress.`;
    }
    const stop = /^stop(?:\s+(all|[1-5]))?$/i.exec(action);
    if (stop) { manager.stop(stop[1]); return "Stop requested for the selected session's subagents."; }
    const inspect = /^inspect\s+([1-5])$/i.exec(action);
    if (inspect) {
      const a = manager.snapshots.find((item) => item.id === inspect[1]);
      if (!a) throw new Error("Subagent not found in the selected session.");
      return `#${a.id} · ${a.role} · ${a.status}\nWorkspace: ${a.workspace}\nTools: ${a.toolCount}\n${a.error ?? a.summary ?? a.preview ?? a.activity ?? "No result yet."}`;
    }
    const chat = /^chat\s+([1-5])$/i.exec(action);
    if (chat) {
      const a = manager.snapshots.find((item) => item.id === chat[1]);
      if (!a) throw new Error("Subagent not found in the selected session.");
      return a.messages?.map((m) => `${m.role}: ${m.text}`).join("\n\n").slice(-16000) || "No recorded messages.";
    }
    const message = /^message\s+([1-5])\s+([\s\S]+)$/i.exec(action);
    if (message) return manager.sendMessage(message[1]!, message[2]!);
    const open = /^open\s+([1-5])$/i.exec(action);
    if (open) { await manager.open(open[1]!); return "Opened the requested subagent tab."; }
    if (action.toLowerCase() === "results") {
      const agents = manager.snapshots;
      return agents.length ? agents.map((a) => `#${a.id} · ${a.role} [${a.status}]\nWorkspace: ${a.workspace}\nIntegrated: ${a.changedFiles?.join(", ") || "none"}\nConflicts: ${a.conflicts?.join(", ") || "none"}\n${a.error ?? a.summary ?? a.preview ?? "No result yet."}`).join("\n\n") : "No results for selected session.";
    }
    throw new Error("Usage: /swarm start <1-5> <objective>|status|inspect <id>|chat <id>|message <id> <text>|open <id>|results|history|report <id>|stop [id|all]");
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
    for (const swarm of this.detachedSwarms.values()) if (swarm.approve(id, allowed)) return true;
    const runtime = this.approvals.get(id);
    if (!runtime) return false;
    runtime.approvals.respond(id, allowed);
    this.approvals.delete(id);
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.detachedSwarms.values()].map((manager) => manager.shutdown()));
    this.detachedSwarms.clear();
    for (const worker of this.workers.values()) {
      worker.controller?.abort();
      worker.runtime?.approvals.denyAll();
    }
    await Promise.allSettled([...this.workers.values()].map(async (worker) => {
      await worker.browser.closeSideChat().catch(() => undefined);
      await worker.store.flush().catch(() => undefined);
      worker.unsubscribe();
    }));
    for (const worker of this.workers.values()) {
      worker.runtime?.timers.dispose();
      await worker.runtime?.externalMcp.close().catch(() => undefined);
      await worker.runtime?.exec.dispose().catch(() => undefined);
    }
    this.workers.clear();
    this.approvals.clear();
  }

  private async workerFor(choice: TelegramSessionChoice): Promise<SessionWorker> {
    const existing = this.workers.get(choice.id);
    if (existing?.browser.isOpen) return existing;
    if (existing) {
      await existing.browser.closeSideChat().catch(() => undefined);
      existing.runtime?.timers.dispose();
      await existing.runtime?.externalMcp.close().catch(() => undefined);
      await existing.runtime?.exec.dispose().catch(() => undefined);
      existing.unsubscribe();
      this.workers.delete(choice.id);
    }
    if (!this.rootBrowser.isOpen) throw new Error("The main browser is not connected yet.");
    const events = new HarnessEvents();
    const store = new SessionStore(choice.workspace, (error) => this.emit({ type: "notice", level: "error", text: error.message }));
    await store.loadDetached(choice.id);
    const browser = await this.rootBrowser.openSideChat(events, { attachConnector: true });
    browser.setResponseChannel("telegram");
    const overrides = store.snapshot.browserOverrides;
    if (overrides?.modelLabel !== undefined) browser.setPickerPreference("model", overrides.modelLabel);
    if (overrides?.effortLabel !== undefined) browser.setPickerPreference("effort", overrides.effortLabel);
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
    const runtime = createRuntime({ ...this.config, workspace: choice.workspace, browser: { ...this.config.browser } }, events);
    runtime.goal.restore(store.snapshot.goal);
    runtime.plan.update(store.snapshot.plan);
    runtime.attachments.restore(store.id, store.snapshot.attachments);
    runtime.context.browser = browser;
    runtime.context.beforeToolStart = () => browser.snapshotBeforeTool();
    worker.runtime = runtime;
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
      const runtime = worker.runtime!;
      runtime.context.turnId = turnId;
      runtime.attachments.restore(worker.store.id, worker.store.snapshot.attachments);
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
        const pending = runtime.attachments.pending;
        const uploads: { id: string; name: string; path: string }[] = [];
        let attachmentBytes = 0;
        for (const item of pending.filter((attachment) => attachment.kind === "file")) {
          const resolved = await runtime.attachments.resolve(item.id);
          const info = await stat(resolved.file);
          if (!info.isFile()) throw new Error("Attached file is no longer a regular file: " + item.name);
          attachmentBytes += info.size;
          uploads.push({ id: item.id, name: item.name, path: resolved.file });
        }
        if (uploads.length > 10 || attachmentBytes > 50 * 1024 * 1024) throw new Error("At most 10 files and 50 MB can be sent in one Telegram session turn.");
        const attachmentInfo = pending.map((item) => item.kind + ": " + item.name + " (attachment_id " + item.id + ")").join("\n");
        const originalPrompt = worker.hasSent ? message : `${history}\n\nNEW USER MESSAGE FROM TELEGRAM:\n${message}`;
        const prompt = attachmentInfo ? originalPrompt + "\n\nSELECTED SESSION ATTACHMENTS\n" + attachmentInfo : originalPrompt;
        const answer = await worker.browser.send(prompt, controller.signal, {
          turnId, continueChat: worker.hasSent, files: uploads,
          ...(uploads.length ? { onSubmitted: () => runtime.attachments.markSent(uploads.map((file) => file.id)) } : {}),
        });
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
          if (worker.controller?.signal.aborted) await runtime.exec.stopTurn(turnId).catch(() => undefined);
          await captureRemoteRuntime(runtime, worker.store).catch(() => undefined);
        }
        worker.controller = undefined;
        worker.runtime = undefined;
        worker.busy = false;
        await worker.store.flush().catch(() => undefined);
      }
    }
  }
}

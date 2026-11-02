import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { HarnessConfig } from "../config.js";
import { ChatGptBrowser } from "../browser/chatgpt.js";
import { HarnessEvents } from "../events.js";
import type { McpHost } from "../mcp/server.js";
import { createRuntime, type Runtime } from "../runtime/context.js";
import { harnessHome } from "../utils/paths.js";
import { newId } from "../utils/ids.js";
import type { SubagentSnapshot } from "../types.js";

const execGit = promisify(execFile);
const MAX_AGENTS = 5;
const ROLES = [
  "Architecture & discovery",
  "Implementation",
  "Tests & verification",
  "Reliability & review",
  "UX & polish",
] as const;

type AgentRecord = {
  info: SubagentSnapshot;
  controller: AbortController;
  turnId: string;
  runtime?: Runtime;
  browser?: ChatGptBrowser;
  task?: Promise<void>;
  approvalIds: Set<string>;
  lastPreviewPublish?: number;
};

export class SubagentManager {
  private agents: AgentRecord[] = [];
  private initializing = false;
  private startupController?: AbortController;

  constructor(
    private readonly config: HarnessConfig,
    private readonly primaryBrowser: ChatGptBrowser,
    private readonly mcp: McpHost,
    private readonly events: HarnessEvents,
  ) {}

  get snapshots(): SubagentSnapshot[] {
    return this.agents.map((agent) => ({ ...agent.info }));
  }

  private publish(): void {
    this.events.emit({ type: "subagents", agents: this.snapshots });
  }

  get active(): boolean {
    return this.initializing || this.agents.some((agent) => ["preparing", "running"].includes(agent.info.status));
  }

  async start(count: number, objective: string): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > MAX_AGENTS) throw new Error("Choose 1–5 subagents.");
    if (!objective.trim()) throw new Error("Usage: /swarm start <1-5> <objective>");
    if (this.active) throw new Error("A swarm is already running. Use /swarm status or /swarm stop.");
    if (!this.primaryBrowser.isOpen) throw new Error("Connect the primary ChatGPT browser first.");
    if (!this.config.browser.attachConnector) throw new Error("Coding subagents require the configured MCP connector.");

    // Only /swarm start calls this method; never auto-spawn from an agent prompt.
    this.initializing = true;
    const startup = new AbortController();
    this.startupController = startup;
    this.agents = [];
    this.publish();
    try {
      const { stdout: rootOutput } = await execGit("git", ["-C", this.config.workspace, "rev-parse", "--show-toplevel"], { timeout: 15_000, windowsHide: true, signal: startup.signal });
      const root = rootOutput.trim();
      const { stdout: dirty } = await execGit("git", ["-C", root, "status", "--porcelain"], { timeout: 15_000, windowsHide: true, signal: startup.signal });
      if (dirty.trim()) throw new Error("The Git working tree has uncommitted changes. Commit or stash them before /swarm start; workers branch from HEAD.");
      const runId = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      const worktreeRoot = path.join(harnessHome(), "worktrees");
      await mkdir(worktreeRoot, { recursive: true });
      // Serialize Git operations to avoid repository lock contention.
      for (let index = 0; index < count; index += 1) {
        startup.signal.throwIfAborted();
        const id = String(index + 1);
        const branch = `chatgpt-coder/swarm-${runId}-${id}`;
        const workspace = path.join(worktreeRoot, `swarm-${runId}-${id}`);
        await execGit("git", ["-C", root, "worktree", "add", "-b", branch, workspace, "HEAD"], { timeout: 60_000, windowsHide: true, signal: startup.signal });
        const record: AgentRecord = {
          info: { id, role: ROLES[index]!, objective, status: "preparing", branch, workspace, toolCount: 0, startedAt: Date.now() },
          controller: new AbortController(),
          turnId: newId("turn"),
          approvalIds: new Set(),
        };
        this.agents.push(record);
        this.publish();
      }
      startup.signal.throwIfAborted();
    } catch (error) {
      for (const agent of this.agents) {
        agent.info = { ...agent.info, status: startup.signal.aborted ? "stopped" : "failed", finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
      }
      this.publish();
      throw error;
    } finally {
      this.initializing = false;
      this.startupController = undefined;
      this.publish();
    }

    // All workers operate in independent background browser tabs and Git worktrees.
    for (const agent of this.agents) agent.task = this.runAgent(agent);
    this.events.emit({ type: "notice", level: "info", text: `Started ${this.agents.length} isolated subagents in background tabs. Their Git worktrees are not merged automatically.` });
  }

  approve(id: string, allowed: boolean): boolean {
    for (const agent of this.agents) {
      if (agent.approvalIds.has(id) && agent.runtime) {
        agent.runtime.approvals.respond(id, allowed);
        return true;
      }
    }
    return false;
  }

  stop(id?: string): void {
    const targets = id && id !== "all" ? this.agents.filter((agent) => agent.info.id === id) : this.agents;
    if (!targets.length) {
      if (!id || id === "all") { this.startupController?.abort(); return; }
      throw new Error(`No subagent with id ${id}.`);
    }
    this.startupController?.abort();
    for (const agent of targets) {
      if (!["preparing", "running"].includes(agent.info.status)) continue;
      agent.controller.abort();
      agent.runtime?.approvals.denyAll();
      if (agent.browser) void agent.browser.stop().catch(() => undefined);
      if (agent.runtime) void agent.runtime.exec.stopTurn(agent.turnId).catch(() => undefined);
      agent.info = { ...agent.info, status: "stopped", activity: "stopped by user", finishedAt: Date.now() };
    }
    this.publish();
  }

  async shutdown(): Promise<void> {
    this.stop("all");
    await Promise.allSettled(this.agents.map((agent) => agent.task).filter((task): task is Promise<void> => Boolean(task)));
  }

  private async runAgent(agent: AgentRecord): Promise<void> {
    const { info, controller, turnId } = agent;
    const sideEvents = new HarnessEvents();
    const config: HarnessConfig = { ...this.config, workspace: info.workspace, browser: { ...this.config.browser } };
    const runtime = createRuntime(config, sideEvents, turnId);
    agent.runtime = runtime;
    runtime.context.turnSignal = controller.signal;
    const unsubscribe = sideEvents.on((event) => {
      if (event.type === "tool-start") {
        agent.info = { ...agent.info, toolCount: agent.info.toolCount + 1, activity: `${event.call.name} · running` };
        this.publish();
      } else if (event.type === "tool-end") {
        agent.info = { ...agent.info, activity: `${event.call.name} · ${event.call.status}` };
        this.publish();
      } else if (event.type === "assistant-delta") {
        agent.info = { ...agent.info, preview: event.text.slice(-1_200) };
        const now = Date.now();
        if (now - (agent.lastPreviewPublish ?? 0) > 800) {
          agent.lastPreviewPublish = now;
          this.publish();
        }
      } else if (event.type === "approval") {
        agent.approvalIds.add(event.request.id);
        this.events.emit({ type: "approval", request: { ...event.request, summary: `Agent ${info.id} · ${event.request.summary}` } });
      } else if (event.type === "approval-resolved") {
        agent.approvalIds.delete(event.id);
        this.events.emit(event);
      }
    });
    try {
      controller.signal.throwIfAborted();
      const browser = await this.primaryBrowser.openSideChat(sideEvents, { attachConnector: true });
      agent.browser = browser;
      runtime.context.browser = browser;
      runtime.context.beforeToolStart = () => browser.snapshotBeforeTool();
      controller.signal.throwIfAborted();
      this.mcp.registerTurnContext(turnId, runtime.context);
      agent.info = { ...agent.info, status: "running", activity: "ChatGPT working" };
      this.publish();
      const prompt = [
        "You are one explicitly user-launched coding subagent in an isolated Git worktree.",
        `Your role: ${info.role}. Agent ${info.id} of ${this.agents.length}.`,
        `Workspace: ${info.workspace}. Git branch: ${info.branch}.`,
        "Do not modify the parent workspace or other agents' worktrees. Work only inside this worktree.",
        "Use the supplied MCP tools with the exact turn_id. Respect all approval requests.",
        "Do not merge, push, publish, or deploy without explicit user approval.",
        "Your worktree is based on committed HEAD; do not assume uncommitted parent files exist.",
        "Make concrete changes relevant to your role, run tests appropriate to your changes and report actual results.",
        "If your assignment overlaps another agent, focus on your named role and minimize edits outside that scope.",
        "Finish with a concise summary of files changed, tests and failures, and any suggested integration steps.",
        `USER-APPROVED SWARM OBJECTIVE\n${info.objective}`,
      ].join("\n\n");
      const answer = await browser.send(prompt, controller.signal, { turnId });
      controller.signal.throwIfAborted();
      agent.info = { ...agent.info, status: "done", activity: "completed", summary: answer.slice(-6000), preview: undefined, finishedAt: Date.now() };
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      agent.info = {
        ...agent.info,
        status: aborted ? "stopped" : "failed",
        activity: aborted ? "cancelled" : "failed",
        error: aborted ? undefined : error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      };
    } finally {
      this.mcp.unregisterTurnContext(turnId);
      for (const approvalId of agent.approvalIds) {
        runtime.approvals.respond(approvalId, false);
      }
      runtime.approvals.denyAll();
      await agent.browser?.closeSideChat().catch(() => undefined);
      await runtime.exec.stopTurn(turnId).catch(() => undefined);
      runtime.timers.dispose();
      await runtime.externalMcp.close().catch(() => undefined);
      await runtime.exec.dispose().catch(() => undefined);
      unsubscribe();
      this.publish();
    }
  }
}

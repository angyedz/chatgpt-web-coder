import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config.js";
import { ChatGptBrowser } from "../browser/chatgpt.js";
import { HarnessEvents } from "../events.js";
import type { McpHost } from "../mcp/server.js";
import { createRuntime, type Runtime } from "../runtime/context.js";
import { harnessHome, isInside } from "../utils/paths.js";
import { newId } from "../utils/ids.js";
import type { SubagentSnapshot } from "../types.js";
import { listSwarmReports, readSwarmReport, saveSwarmReport, type SwarmReport } from "./swarm-reports.js";

const MAX_AGENTS = 5;
const ROLES = [
  "Architecture & discovery",
  "Implementation",
  "Tests & verification",
  "Reliability & review",
  "UX & polish",
] as const;
const IGNORED_PATHS = new Set([
  ".git", ".svn", ".hg", "node_modules", "dist", "coverage", ".cache", ".turbo",
  ".next", ".nuxt", ".output", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", "target", "release", "artifacts", "tmp", ".tmp",
]);

type WorkspaceManifest = Map<string, string>;
type IntegrationResult = { applied: string[]; conflicts: string[] };

type AgentRecord = {
  info: SubagentSnapshot;
  controller: AbortController;
  turnId: string;
  baseFiles: WorkspaceManifest;
  runtime?: Runtime;
  browser?: ChatGptBrowser;
  task?: Promise<void>;
  approvalIds: Set<string>;
  lastPreviewPublish?: number;
  settled?: boolean;
};

function isIgnored(relative: string, stateRelative?: string): boolean {
  const normalized = relative.split(path.sep).filter(Boolean);
  if (normalized.some((part) => IGNORED_PATHS.has(part.toLowerCase()))) return true;
  if (stateRelative) {
    const state = stateRelative.split(path.sep).filter(Boolean);
    if (normalized.length >= state.length && state.every((part, index) => normalized[index] === part)) return true;
  }
  return false;
}

function stateRelativeTo(root: string): string | undefined {
  const state = path.resolve(harnessHome());
  if (path.resolve(root) === state) throw new Error("The project workspace cannot be the ChatGPT Coder state directory.");
  return isInside(root, state) ? path.relative(path.resolve(root), state) : undefined;
}

async function scanWorkspace(root: string, signal?: AbortSignal): Promise<WorkspaceManifest> {
  const manifest: WorkspaceManifest = new Map();
  const stateRelative = stateRelativeTo(root);
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (isIgnored(relative, stateRelative)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
        manifest.set(relative.split(path.sep).join("/"), digest);
      }
    }
  };
  await visit(root);
  return manifest;
}

async function createWorkspaceSnapshot(sourceRoot: string, destination: string, signal: AbortSignal): Promise<WorkspaceManifest> {
  const root = path.resolve(sourceRoot);
  const stateRelative = stateRelativeTo(root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("The configured workspace must be a real directory.");
  await cp(root, destination, {
    recursive: true,
    errorOnExist: true,
    filter: async (source) => {
      signal.throwIfAborted();
      const relative = path.relative(root, source);
      if (!relative) return true;
      if (isIgnored(relative, stateRelative)) return false;
      const info = await lstat(source).catch(() => undefined);
      return Boolean(info && !info.isSymbolicLink() && (info.isDirectory() || info.isFile()));
    },
  });

  // Share installed dependencies read-only by convention; project files stay isolated.
  // A junction is used on Windows so no administrator/developer symlink privilege is needed.
  const dependencies = path.join(root, "node_modules");
  const dependencyInfo = await lstat(dependencies).catch(() => undefined);
  if (dependencyInfo?.isDirectory() && !dependencyInfo.isSymbolicLink()) {
    await symlink(dependencies, path.join(destination, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  return scanWorkspace(destination, signal);
}

async function ensureSafeParent(root: string, relative: string): Promise<void> {
  let current = path.resolve(root);
  const parts = relative.split("/");
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const existing = await lstat(current).catch(() => undefined);
    if (!existing) {
      await mkdir(current);
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("A parent path is not a safe directory.");
    }
  }
}

async function integrateWorkspaceChanges(
  sourceRoot: string,
  agentWorkspace: string,
  baseFiles: WorkspaceManifest,
): Promise<IntegrationResult> {
  const root = path.resolve(sourceRoot);
  const [agentFiles, currentFiles] = await Promise.all([
    scanWorkspace(agentWorkspace),
    scanWorkspace(root),
  ]);
  const candidates: Array<{ relative: string; before?: string; digest?: string }> = [];
  const conflicts: string[] = [];
  const allPaths = new Set([...baseFiles.keys(), ...agentFiles.keys()]);

  for (const relative of allPaths) {
    const before = baseFiles.get(relative);
    const after = agentFiles.get(relative);
    if (before === after) continue;
    const current = currentFiles.get(relative);
    // Apply only when the parent file is unchanged since launch or already
    // contains this exact result. Concurrent edits are reported, never overwritten.
    if (current !== before && current !== after) {
      conflicts.push(relative);
      continue;
    }
    candidates.push({ relative, before, digest: after });
  }

  const applied: string[] = [];
  for (const change of candidates) {
    const target = path.resolve(root, ...change.relative.split("/"));
    if (!isInside(root, target)) {
      conflicts.push(change.relative);
      continue;
    }
    try {
      await ensureSafeParent(root, change.relative);
      const existing = await lstat(target).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw new Error("Refusing to write through a symbolic link.");
      const currentDigest = existing?.isFile() ? createHash("sha256").update(await readFile(target)).digest("hex") : undefined;
      if (currentDigest !== change.before && currentDigest !== change.digest) throw new Error("The parent file changed during integration.");
      if (change.digest === undefined) {
        if (existing && !existing.isFile()) throw new Error("The target is no longer a regular file.");
        if (existing) await rm(target);
      } else {
        if (existing && !existing.isFile()) throw new Error("The target is no longer a regular file.");
        const source = path.resolve(agentWorkspace, ...change.relative.split("/"));
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("The agent result is not a regular file.");
        await copyFile(source, target);
      }
      applied.push(change.relative);
    } catch {
      conflicts.push(change.relative);
    }
  }
  return { applied, conflicts: [...new Set(conflicts)].sort() };
}

export class SubagentManager {
  private agents: AgentRecord[] = [];
  private initializing = false;
  private startupController?: AbortController;
  private reportId?: string;
  private reportQueue: Promise<void> = Promise.resolve();
  private integrationQueue: Promise<void> = Promise.resolve();
  private sourceRoot?: string;

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

  private persistReport(): void {
    const id = this.reportId;
    const agents = this.snapshots;
    if (!id || !agents.length) return;
    const report: SwarmReport = {
      id,
      objective: agents[0]!.objective,
      savedAt: Date.now(),
      agents,
    };
    this.reportQueue = this.reportQueue.catch(() => undefined).then(() => saveSwarmReport(report)).catch((error: unknown) => {
      this.events.emit({ type: "notice", level: "warn", text: `Could not save subagent report: ${error instanceof Error ? error.message : String(error)}` });
    });
  }

  async history(): Promise<SwarmReport[]> {
    await this.reportQueue;
    return listSwarmReports();
  }

  async report(id: string): Promise<SwarmReport> {
    await this.reportQueue;
    return readSwarmReport(id);
  }

  get active(): boolean {
    return this.initializing || this.agents.some((agent) => !agent.settled);
  }

  async start(count: number, objective: string): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > MAX_AGENTS) throw new Error("Choose 1–5 subagents.");
    if (!objective.trim()) throw new Error("Usage: /swarm start <1-5> <objective>");
    if (this.active) throw new Error("A swarm is already running. Use /swarm status or /swarm stop.");
    if (!this.primaryBrowser.isOpen) throw new Error("Connect the primary ChatGPT browser first.");
    if (!this.config.browser.attachConnector) throw new Error("Coding subagents require the configured MCP connector.");

    // Subagents receive private filesystem snapshots. Launching them never
    // inspects or mutates Git metadata and works with uncommitted/non-Git projects.
    this.initializing = true;
    await this.reportQueue;
    const startup = new AbortController();
    this.startupController = startup;
    this.agents = [];
    this.reportId = undefined;
    this.publish();
    try {
      const sourceRoot = await realpath(this.config.workspace);
      this.sourceRoot = sourceRoot;
      const runId = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      this.reportId = runId;
      const workspaceRoot = path.join(harnessHome(), "swarm-workspaces");
      await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      for (let index = 0; index < count; index += 1) {
        startup.signal.throwIfAborted();
        const id = String(index + 1);
        const workspace = path.join(workspaceRoot, `swarm-${runId}-${id}`);
        const baseFiles = await createWorkspaceSnapshot(sourceRoot, workspace, startup.signal);
        const record: AgentRecord = {
          info: { id, role: ROLES[index]!, objective, status: "preparing", workspace, toolCount: 0, startedAt: Date.now() },
          controller: new AbortController(),
          turnId: newId("turn"),
          baseFiles,
          approvalIds: new Set(),
          settled: false,
        };
        this.agents.push(record);
        this.publish();
      }
      startup.signal.throwIfAborted();
    } catch (error) {
      for (const agent of this.agents) {
        agent.info = { ...agent.info, status: startup.signal.aborted ? "stopped" : "failed", finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
        agent.settled = true;
      }
      this.publish();
      this.persistReport();
      throw error;
    } finally {
      this.initializing = false;
      this.startupController = undefined;
      this.publish();
      this.persistReport();
    }

    // Each worker gets a background ChatGPT tab and a private local copy.
    // Safe, non-conflicting file changes are integrated when that worker finishes.
    for (const agent of this.agents) agent.task = this.runAgent(agent);
    this.events.emit({ type: "notice", level: "info", text: `Started ${this.agents.length} isolated subagents in background tabs. Non-conflicting file changes are integrated automatically; conflicting edits remain in each agent workspace.` });
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
    if (!id || id === "all") this.startupController?.abort();
    for (const agent of targets) {
      if (!["preparing", "running"].includes(agent.info.status)) continue;
      agent.controller.abort();
      agent.runtime?.approvals.denyAll();
      if (agent.browser) void agent.browser.stop().catch(() => undefined);
      if (agent.runtime) void agent.runtime.exec.stopTurn(agent.turnId).catch(() => undefined);
      agent.info = { ...agent.info, status: "stopped", activity: "stopped by user", finishedAt: Date.now() };
    }
    this.publish();
    this.persistReport();
  }

  async shutdown(): Promise<void> {
    this.stop("all");
    await Promise.allSettled(this.agents.map((agent) => agent.task).filter((task): task is Promise<void> => Boolean(task)));
    await this.reportQueue;
    await this.integrationQueue;
  }

  private integrate(agent: AgentRecord): Promise<IntegrationResult> {
    const work = this.integrationQueue.catch(() => undefined).then(() =>
      integrateWorkspaceChanges(this.sourceRoot ?? this.config.workspace, agent.info.workspace, agent.baseFiles),
    );
    this.integrationQueue = work.then(() => undefined, () => undefined);
    return work;
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
        this.events.emit({ ...event, agentId: info.id });
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
        "You are one explicitly user-launched coding subagent in an isolated local workspace snapshot.",
        `Your role: ${info.role}. Agent ${info.id} of ${this.agents.length}.`,
        `Workspace: ${info.workspace}.`,
        "This workspace is a private copy of the user's current working files, including uncommitted changes. It has no Git metadata.",
        "Treat the linked node_modules directory as read-only. Do not install packages or modify shared dependencies unless the user explicitly asks.",
        "Do not run Git commands. Do not create branches, commits, worktrees, pull requests, push or publish anything.",
        "Do not modify the parent workspace or other agents' workspaces. Work only inside this workspace.",
        "Use the supplied MCP tools with the exact turn_id. Respect all approval requests.",
        "Make concrete changes relevant to your role, run tests appropriate to your changes and report actual results.",
        "The harness safely integrates non-conflicting changed files into the parent workspace when you finish. If the parent or another worker changed the same file differently, that file is not overwritten; the conflict is reported and your workspace is preserved.",
        "If your assignment overlaps another agent, focus on your named role and minimize edits outside that scope.",
        "Finish with a concise summary of files changed, tests and failures, and any suggested integration steps.",
        `USER-APPROVED SWARM OBJECTIVE\n${info.objective}`,
      ].join("\n\n");
      const answer = await browser.send(prompt, controller.signal, { turnId });
      controller.signal.throwIfAborted();
      const integration = await this.integrate(agent);
      const integrationSummary = integration.applied.length
        ? `${integration.applied.length} file(s) integrated`
        : "no non-conflicting file changes";
      const conflictSummary = integration.conflicts.length
        ? `; ${integration.conflicts.length} conflict(s) kept in the isolated workspace`
        : "";
      agent.info = {
        ...agent.info,
        status: "done",
        activity: `completed · ${integrationSummary}${conflictSummary}`,
        summary: answer.slice(-6_000),
        changedFiles: integration.applied,
        conflicts: integration.conflicts,
        preview: undefined,
        finishedAt: Date.now(),
      };
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
      agent.settled = true;
      this.publish();
      this.persistReport();
    }
  }
}

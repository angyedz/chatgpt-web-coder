import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config.js";
import { ChatGptBrowser, ConnectorAttachmentError } from "../browser/chatgpt.js";
import { HarnessEvents } from "../events.js";
import type { McpHost } from "../mcp/server.js";
import { createRuntime, type Runtime } from "../runtime/context.js";
import { harnessHome, isInside } from "../utils/paths.js";
import { newId } from "../utils/ids.js";
import { setTimeout as delay } from "node:timers/promises";
import { PickerPreparationError } from "../browser/picker.js";
import type { SubagentChatMessage, SubagentSnapshot, SwarmOrchestratorSnapshot } from "../types.js";
import { listSwarmReports, readSwarmReport, saveSwarmReport, type SwarmReport } from "./swarm-reports.js";
import { ORCHESTRATOR_TOOLS, validateSwarmReview, SWARM_REVIEW_INTERVAL_MS, swarmOrchestratorPrompt, type SwarmDecision } from "./swarm-orchestrator.js";

const MAX_AGENTS = 5;
const IGNORED_PATHS = new Set([
  ".git", ".svn", ".hg", "node_modules", "dist", "coverage", ".cache", ".turbo",
  ".next", ".nuxt", ".output", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", "target", "release", "artifacts", "tmp", ".tmp",
  ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".docker", ".terraform", "secrets", "credentials",
]);
const SAFE_ENV_FILES = new Set([".env.example", ".env.sample", ".env.template"]);
const SENSITIVE_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519",
  "credentials.json", "client_secret.json", "service-account.json", "token.json",
  "access_token", "refresh_token", "terraform.tfstate",
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
  sideEvents?: HarnessEvents;
  unsubscribe?: () => void;
  task?: Promise<void>;
  approvalIds: Set<string>;
  lastPreviewPublish?: number;
  settled?: boolean;
  hasSubmittedTask?: boolean;
  pendingMessages: string[];
};

function isIgnored(relative: string, stateRelative?: string): boolean {
  const normalized = relative.split(path.sep).filter(Boolean);
  const lower = normalized.map((part) => part.toLowerCase());
  if (lower.some((part) => IGNORED_PATHS.has(part))) return true;
  if (lower.includes(".config") && lower.includes("gcloud")) return true;
  const filename = lower.at(-1);
  if (filename && (
    filename === ".env" ||
    (filename.startsWith(".env.") && !SAFE_ENV_FILES.has(filename)) ||
    SENSITIVE_FILES.has(filename) ||
    filename.startsWith("secrets.") ||
    filename.endsWith(".secret") ||
    /\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc)$/i.test(filename) ||
    filename.endsWith(".tfstate")
  )) return true;
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
  private orchestratorState?: SwarmOrchestratorSnapshot;
  private orchestratorController?: AbortController;
  private orchestratorBrowser?: ChatGptBrowser;
  private orchestratorTask?: Promise<void>;
  private wakeReview?: () => void;
  private workerRevision = 0;

  constructor(
    private readonly config: HarnessConfig,
    private readonly primaryBrowser: ChatGptBrowser,
    private readonly mcp: McpHost,
    private readonly events: HarnessEvents,
  ) {}

  get snapshots(): SubagentSnapshot[] {
    return this.agents.map((agent) => ({
      ...agent.info,
      queuedInstructions: [...agent.pendingMessages],
      messages: agent.info.messages?.map((message) => ({ ...message })),
    }));
  }

  get orchestration(): SwarmOrchestratorSnapshot | undefined {
    return this.orchestratorState ? { ...this.orchestratorState } : undefined;
  }

  private recordChatMessage(agent: AgentRecord, message: SubagentChatMessage, publish = true): void {
    const current = agent.info.messages ?? [];
    const existing = current.find((item) => item.id === message.id);
    const nextMessage: SubagentChatMessage = {
      ...existing,
      ...message,
      createdAt: existing?.createdAt ?? message.createdAt,
      text: message.text.slice(-4_000),
    };
    const next = existing
      ? current.map((item) => item.id === message.id ? nextMessage : item)
      : [...current, nextMessage].slice(-24);
    agent.info = { ...agent.info, messages: next };
    if (publish) this.publish();
  }

  private publish(): void {
    this.events.emit({ type: "subagents", agents: this.snapshots, orchestrator: this.orchestration });
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
      orchestrator: this.orchestration,
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
    return this.initializing || Boolean(this.orchestratorController)
      || this.agents.some((agent) => !agent.settled);
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
    await Promise.all(this.agents.map(async (agent) => {
      await agent.browser?.closeSideChat().catch(() => undefined);
      agent.unsubscribe?.();
    }));
    this.agents = [];
    this.reportId = undefined;
    this.orchestratorState = { status: "planning", summary: "Planning assignments for the requested worker count." };
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
          info: { id, role: "Awaiting assignment", objective, status: "preparing", workspace, toolCount: 0, startedAt: Date.now(), activity: "Orchestrator is planning the task" },
          controller: new AbortController(),
          turnId: newId("turn"),
          baseFiles,
          approvalIds: new Set(),
          settled: true,
          pendingMessages: [],
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
      this.orchestratorState = { status: startup.signal.aborted ? "stopped" : "failed", summary: error instanceof Error ? error.message : String(error) };
      this.publish();
      this.persistReport();
      throw error;
    } finally {
      this.initializing = false;
      this.startupController = undefined;
      this.publish();
      this.persistReport();
    }

    const controller = new AbortController();
    this.orchestratorController = controller;
    this.orchestratorTask = this.orchestrate(objective, controller);
    this.events.emit({ type: "notice", level: "info", text: `Started an orchestrator for ${this.agents.length} isolated subagents. It assigns tasks from the objective and reviews progress every 30 seconds and after worker completion.` });
  }

  private async orchestrate(objective: string, controller: AbortController): Promise<void> {
    const events = new HarnessEvents();
    const runtime = createRuntime(this.config, events);
    runtime.context.turnSignal = controller.signal;
    runtime.context.allowedTools = ORCHESTRATOR_TOOLS;
    let browser: ChatGptBrowser | undefined;
    let initial = true;
    let feedback = "";
    try {
      browser = await this.primaryBrowser.openSideChat(events, { attachConnector: true });
      this.orchestratorBrowser = browser;
      let reviews = 0;
      while (!controller.signal.aborted) {
        this.orchestratorState = { ...this.orchestratorState, status: initial ? "planning" : "reviewing" };
        this.publish();
        const turnId = newId("swarm-review");
        const reviewedRevision = this.workerRevision;
        runtime.context.turnId = turnId;
        runtime.context.beforeToolStart = () => browser!.snapshotBeforeTool();
        this.mcp.registerTurnContext(turnId, runtime.context);
        const submitted: { decision?: SwarmDecision } = {};
        runtime.context.reviewSwarm = (input) => {
          controller.signal.throwIfAborted();
          if (runtime.context.turnId !== turnId) throw new Error("This swarm review turn has expired.");
          if (submitted.decision) throw new Error("This review was already applied. Wait for the next review turn before dispatching more work.");
          const review = validateSwarmReview(input, this.snapshots, initial);
          // A worker may already have produced a result while its runtime is
          // still cleaning up. Validate all slots before applying any action.
          if (review.assignments.some((assignment) => !this.agents.find((agent) => agent.info.id === assignment.id)?.settled)) throw new Error("An assigned worker is still finishing its previous turn. Wait for the next review.");
          if (review.status !== "continue" && this.agents.some((agent) => !agent.settled)) throw new Error("Workers are still finishing their turns. Review their final results before a terminal update.");
          this.applyReview(review);
          submitted.decision = review;
          return `Swarm review applied: ${review.status}. ${review.assignments.length} assignment(s), ${review.instructions.length} instruction(s), ${review.waiting.length} waiting slot(s). ${review.summary}`;
        };
        try {
          const continueChat = reviews++ % 12 !== 0;
          await browser.send([
            swarmOrchestratorPrompt(objective, this.snapshots, initial),
            `Workspace: ${this.config.workspace}\nUse only the configured MCP connector. Allowed tools: ${ORCHESTRATOR_TOOLS.join(", ")}. Every call requires turn_id: ${turnId}.`,
            this.orchestratorState?.summary ? `PREVIOUS REVIEW SUMMARY\n${this.orchestratorState.summary}` : "",
            feedback,
          ].filter(Boolean).join("\n\n"), controller.signal, { turnId, continueChat });
        } catch (error) {
          controller.signal.throwIfAborted();
          // Retrying browser setup is safe: this error is raised before Send.
          // Once a review was applied, preserve it even if response observation
          // fails afterwards; never dispatch its assignments a second time.
          if (!submitted.decision && !(error instanceof ConnectorAttachmentError || error instanceof PickerPreparationError)) throw error;
          this.events.emit({ type: "notice", level: "warn", text: `Swarm coordinator: ${error instanceof Error ? error.message : String(error)}${submitted.decision ? " Applied MCP actions were preserved." : " No message was sent; browser setup will retry."}` });
        } finally {
          runtime.context.reviewSwarm = undefined;
          this.mcp.unregisterTurnContext(turnId);
        }
        controller.signal.throwIfAborted();
        const decision = submitted.decision;
        if (!decision) {
          feedback = "No successful update_swarm MCP call was received in the previous review. Assistant text cannot control the swarm. Inspect any actual tool error, then call update_swarm through the connector with the current turn_id. Do not output JSON or pretend to call a tool.";
          this.orchestratorState = { ...this.orchestratorState, status: initial ? "planning" : "monitoring", summary: "Waiting for an MCP review; existing worker tasks are preserved. The orchestrator will retry." };
          this.events.emit({ type: "notice", level: "warn", text: "Swarm orchestrator returned without an MCP review. Retrying; no workers were failed or restarted." });
          this.publish();
          this.persistReport();
          await this.waitForReview(controller.signal, false);
          continue;
        }
        feedback = "";
        if (decision.status !== "continue") break;
        initial = false;
        this.publish();
        this.persistReport();
        if (reviewedRevision !== this.workerRevision) continue;
        await this.waitForReview(controller.signal, Boolean(decision.assignments.length || decision.instructions.length));
      }
    } catch (error) {
      this.orchestratorState = {
        status: controller.signal.aborted ? "stopped" : "failed",
        summary: controller.signal.aborted ? "Stopped by the user." : error instanceof Error ? error.message : String(error),
        lastReviewedAt: Date.now(),
      };
      for (const agent of this.agents) if (!agent.info.assignment && agent.settled && agent.info.status !== "stopped") {
        agent.info = { ...agent.info, status: "idle", activity: "Awaiting assignment; coordinator unavailable" };
      }
      if (!controller.signal.aborted) this.events.emit({ type: "notice", level: "error", text: `Swarm orchestrator: ${this.orchestratorState.summary}` });
    } finally {
      runtime.approvals.denyAll();
      runtime.timers.dispose();
      await runtime.externalMcp.close().catch(() => undefined);
      await runtime.exec.dispose().catch(() => undefined);
      await browser?.closeSideChat().catch(() => undefined);
      this.orchestratorBrowser = undefined;
      if (this.orchestratorController === controller) this.orchestratorController = undefined;
      this.publish();
      this.persistReport();
    }
  }

  private applyReview(decision: SwarmDecision): void {
    for (const assignment of decision.assignments) this.assignWorker(assignment.id, assignment.role, assignment.task);
    for (const instruction of decision.instructions) this.queueInstruction(instruction.id, instruction.message);
    for (const waiting of decision.waiting) {
      const agent = this.agents.find((item) => item.info.id === waiting.id)!;
      agent.info = { ...agent.info, status: "idle", activity: waiting.reason };
    }
    if (decision.status !== "continue") for (const agent of this.agents) {
      if (!agent.info.assignment && agent.settled && agent.info.status !== "stopped") agent.info = { ...agent.info, status: "idle", activity: decision.summary };
    }
    this.orchestratorState = { status: decision.status === "continue" ? "monitoring" : decision.status, summary: decision.summary, lastReviewedAt: Date.now() };
    this.events.emit({ type: "notice", level: "info", text: `Swarm orchestrator [${this.orchestratorState.status}]: ${decision.summary}` });
    this.publish();
    this.persistReport();
  }

  private waitForReview(signal: AbortSignal, immediateWhenIdle: boolean): Promise<void> {
    if (signal.aborted || (immediateWhenIdle && !this.agents.some((agent) => !agent.settled))) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.wakeReview === finish) this.wakeReview = undefined;
        resolve();
      };
      const timer = setTimeout(finish, SWARM_REVIEW_INTERVAL_MS);
      this.wakeReview = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  private assignWorker(id: string, role: string, task: string): void {
    const agent = this.agents.find((item) => item.info.id === id)!;
    if (!agent.settled || agent.info.status === "stopped") throw new Error(`Worker ${id} is not available for assignment.`);
    agent.info = { ...agent.info, role, assignment: task, status: "running", activity: "Orchestrator assigned a task", summary: undefined, error: undefined, failurePhase: undefined, finishedAt: undefined };
    const instruction = [task, ...agent.pendingMessages.splice(0)].join("\n\n");
    agent.settled = false;
    if (agent.browser?.isOpen && agent.sideEvents && agent.hasSubmittedTask) {
      agent.task = this.runFollowup(agent, instruction).then(() => undefined, () => undefined);
    } else {
      agent.controller = new AbortController();
      agent.turnId = newId("turn");
      agent.task = this.runAgent(agent, instruction);
    }
  }

  private queueInstruction(id: string, message: string): void {
    const agent = this.agents.find((item) => item.info.id === id);
    if (!agent || agent.info.status === "stopped") throw new Error(`Worker ${id} is unavailable.`);
    if (!agent.settled || !agent.browser?.isOpen) {
      if (!agent.pendingMessages.includes(message)) agent.pendingMessages.push(message);
    }
    else agent.task = this.runFollowup(agent, message).then(() => undefined, () => undefined);
  }

  private workerFinished(agent: AgentRecord): void {
    this.workerRevision += 1;
    agent.settled = true;
    if (!agent.controller.signal.aborted && agent.pendingMessages.length && agent.browser?.isOpen) {
      const instruction = agent.pendingMessages.splice(0).join("\n\n");
      agent.task = this.runFollowup(agent, instruction).then(() => undefined, () => undefined);
    }
    this.publish();
    this.persistReport();
    this.wakeReview?.();
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
    if (!id || id === "all") {
      this.startupController?.abort();
      this.orchestratorController?.abort();
      if (this.orchestratorBrowser) void this.orchestratorBrowser.stop().catch(() => undefined);
      if (this.orchestratorController) this.orchestratorState = { ...this.orchestratorState, status: "stopped", summary: "Stopped by the user." };
    }
    for (const agent of targets) {
      agent.pendingMessages = [];
      if (agent.info.status === "idle" && !this.orchestratorController) continue;
      if (!["preparing", "idle", "running"].includes(agent.info.status)) {
        if (id && id !== "all") agent.info = { ...agent.info, status: "stopped", activity: "stopped by user" };
        continue;
      }
      agent.controller.abort();
      agent.runtime?.approvals.denyAll();
      if (agent.browser) void agent.browser.stop().catch(() => undefined);
      if (agent.runtime) void agent.runtime.exec.stopTurn(agent.turnId).catch(() => undefined);
      agent.info = { ...agent.info, status: "stopped", activity: "stopped by user", finishedAt: Date.now() };
    }
    this.publish();
    this.persistReport();
    this.wakeReview?.();
  }

  async shutdown(): Promise<void> {
    this.stop("all");
    await this.orchestratorTask;
    await Promise.allSettled(this.agents.map((agent) => agent.task).filter((task): task is Promise<void> => Boolean(task)));
    await Promise.all(this.agents.map(async (agent) => {
      await agent.browser?.closeSideChat().catch(() => undefined);
      agent.unsubscribe?.();
      agent.browser = undefined;
      agent.sideEvents = undefined;
    }));
    await this.reportQueue;
    await this.integrationQueue;
  }

  private integrate(agent: AgentRecord): Promise<IntegrationResult> {
    const work = this.integrationQueue.catch(() => undefined).then(async () => {
      const result = await integrateWorkspaceChanges(this.sourceRoot ?? this.config.workspace, agent.info.workspace, agent.baseFiles);
      if (result.applied.length) {
        const latest = await scanWorkspace(agent.info.workspace);
        for (const relative of result.applied) {
          const digest = latest.get(relative);
          if (digest === undefined) agent.baseFiles.delete(relative);
          else agent.baseFiles.set(relative, digest);
        }
      }
      return result;
    });
    this.integrationQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  private refreshWorkspace(agent: AgentRecord): Promise<void> {
    const work = this.integrationQueue.catch(() => undefined).then(async () => {
      // Reverse the same conflict-safe copy operation: refresh only files the
      // worker has not changed, preserving its unintegrated edits.
      const result = await integrateWorkspaceChanges(agent.info.workspace, this.sourceRoot ?? this.config.workspace, agent.baseFiles);
      const current = await scanWorkspace(agent.info.workspace);
      for (const relative of result.applied) {
        const digest = current.get(relative);
        if (digest === undefined) agent.baseFiles.delete(relative);
        else agent.baseFiles.set(relative, digest);
      }
    });
    this.integrationQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  async open(id: string): Promise<void> {
    const agent = this.agents.find((item) => item.info.id === id);
    if (!agent) throw new Error(`No subagent with id ${id}.`);
    if (!agent.browser?.isOpen) throw new Error(`Subagent ${id} has no open ChatGPT tab.`);
    await agent.browser.bringToFront();
  }

  sendMessage(id: string, message: string): Promise<string> {
    const agent = this.agents.find((item) => item.info.id === id);
    if (!agent) throw new Error(`No subagent with id ${id}.`);
    if (!message.trim()) throw new Error("Usage: /swarm message <id> <instruction>");
    if (!agent.settled || agent.info.status === "running" || (this.orchestratorController && !agent.browser && ["preparing", "idle"].includes(agent.info.status))) {
      agent.pendingMessages.push(message.trim());
      this.publish();
      this.wakeReview?.();
      return Promise.resolve(`Instruction queued for subagent ${id}; it will be applied after its current turn.`);
    }
    if (!agent.browser?.isOpen || !agent.sideEvents) throw new Error(`Subagent ${id} has no reusable ChatGPT chat.`);
    const task = this.runFollowup(agent, message.trim());
    agent.task = task.then(() => undefined, () => undefined);
    return task;
  }

  async waitFor(timeoutMs = 120_000): Promise<SubagentSnapshot[]> {
    if (!this.active) return this.snapshots;
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(this.snapshots);
      };
      const unsubscribe = this.events.on((event) => {
        if (event.type === "subagents" && !this.active) finish();
      });
      timer = setTimeout(finish, Math.max(1_000, Math.min(timeoutMs, 300_000)));
      if (!this.active) finish();
    });
  }

  private async runFollowup(agent: AgentRecord, message: string): Promise<string> {
    const browser = agent.browser!;
    const events = agent.sideEvents!;
    const controller = new AbortController();
    const turnId = newId("turn");
    const config: HarnessConfig = { ...this.config, workspace: agent.info.workspace, browser: { ...this.config.browser } };
    const runtime = createRuntime(config, events, turnId);
    agent.controller = controller;
    agent.turnId = turnId;
    agent.runtime = runtime;
    agent.settled = false;
    runtime.context.turnSignal = controller.signal;
    runtime.context.browser = browser;
    runtime.context.beforeToolStart = () => browser.snapshotBeforeTool();
    agent.info = { ...agent.info, status: "running", activity: "Orchestrator sent a follow-up", summary: undefined, preview: undefined, error: undefined, failurePhase: undefined, finishedAt: undefined };
    this.recordChatMessage(agent, { id: newId("agent-user"), role: "user", text: message, createdAt: Date.now() });
    let registered = false;
    try {
      await this.refreshWorkspace(agent);
      controller.signal.throwIfAborted();
      this.mcp.registerTurnContext(turnId, runtime.context);
      registered = true;
      const answer = await this.sendWorker(agent, browser, `ORCHESTRATOR FOLLOW-UP\nUse actual MCP tools exclusively for actions; explain results in ordinary prose, never a JSON reply or tool-call imitation.\nWorkspace: ${agent.info.workspace}\nCurrent role: ${agent.info.role}\nShared objective: ${agent.info.objective}\n\nFollow this latest assignment or correction:\n${message}\n\nUnchanged files in your workspace have been refreshed from the parent project. Inspect current files before editing. Your unintegrated conflicting edits are preserved.`, controller.signal, { turnId, continueChat: true });
      controller.signal.throwIfAborted();
      const integration = await this.integrate(agent);
      agent.info = {
        ...agent.info,
        status: "done",
        activity: `follow-up completed · ${integration.applied.length} file(s) integrated${integration.conflicts.length ? `; ${integration.conflicts.length} conflict(s)` : ""}`,
        summary: answer.slice(-6_000),
        changedFiles: [...new Set([...(agent.info.changedFiles ?? []), ...integration.applied])],
        conflicts: integration.conflicts,
        finishedAt: Date.now(),
      };
      return answer;
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      agent.info = {
        ...agent.info,
        status: aborted ? "stopped" : "failed",
        activity: aborted ? "follow-up cancelled" : "follow-up failed",
        error: aborted ? undefined : error instanceof Error ? error.message : String(error),
        failurePhase: aborted ? undefined : error instanceof PickerPreparationError || error instanceof ConnectorAttachmentError ? "setup" : "work",
        finishedAt: Date.now(),
      };
      throw error;
    } finally {
      if (registered) this.mcp.unregisterTurnContext(turnId);
      for (const approvalId of agent.approvalIds) runtime.approvals.respond(approvalId, false);
      runtime.approvals.denyAll();
      await runtime.exec.stopTurn(turnId).catch(() => undefined);
      runtime.timers.dispose();
      await runtime.externalMcp.close().catch(() => undefined);
      await runtime.exec.dispose().catch(() => undefined);
      agent.runtime = undefined;
      this.workerFinished(agent);
    }
  }

  private async runAgent(agent: AgentRecord, assignment: string): Promise<void> {
    const { info, controller, turnId } = agent;
    const unusedBrowser = agent.browser;
    agent.unsubscribe?.();
    agent.browser = undefined;
    agent.hasSubmittedTask = false;
    const sideEvents = new HarnessEvents();
    agent.sideEvents = sideEvents;
    const config: HarnessConfig = { ...this.config, workspace: info.workspace, browser: { ...this.config.browser } };
    const runtime = createRuntime(config, sideEvents, turnId);
    agent.runtime = runtime;
    runtime.context.turnSignal = controller.signal;
    agent.unsubscribe = sideEvents.on((event) => {
      if (event.type === "assistant-start") {
        this.recordChatMessage(agent, { id: event.id, role: "assistant", text: "", createdAt: Date.now(), streaming: true });
      } else if (event.type === "assistant-delta") {
        const now = Date.now();
        const shouldPublish = now - (agent.lastPreviewPublish ?? 0) > 800;
        if (shouldPublish) agent.lastPreviewPublish = now;
        agent.info = { ...agent.info, preview: event.text.slice(-1_200) };
        this.recordChatMessage(agent, { id: event.id, role: "assistant", text: event.text, createdAt: now, streaming: true }, shouldPublish);
      } else if (event.type === "assistant-done") {
        this.recordChatMessage(agent, { id: event.id, role: "assistant", text: event.text, createdAt: Date.now(), streaming: false, interrupted: Boolean(event.error) });
      } else if (event.type === "tool-start") {
        agent.info = { ...agent.info, toolCount: agent.info.toolCount + 1, activity: `${event.call.name} · running` };
        this.publish();
      } else if (event.type === "tool-end") {
        agent.info = { ...agent.info, activity: `${event.call.name} · ${event.call.status}` };
        this.publish();
      } else if (event.type === "approval") {
        agent.approvalIds.add(event.request.id);
        this.events.emit({ type: "approval", request: { ...event.request, summary: `Agent ${info.id} · ${event.request.summary}` } });
      } else if (event.type === "approval-resolved") {
        agent.approvalIds.delete(event.id);
        this.events.emit({ ...event, agentId: info.id });
      }
    });
    try {
      await unusedBrowser?.closeSideChat().catch(() => undefined);
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
        "Use actual MCP tools exclusively for actions. Never output JSON-formatted assistant replies or imitate tool calls in text. Explain results in ordinary prose.",
        `Your role: ${info.role}. Agent ${info.id} of ${this.agents.length}.`,
        `Workspace: ${info.workspace}`,
        "This workspace is a private copy of the project files, including uncommitted changes, but excluding Git metadata, dependency caches and credential files such as .env, private keys and cloud credentials.",
        "Treat the linked node_modules directory as read-only. Do not install packages or modify shared dependencies unless the user explicitly asks.",
        "Do not run Git commands. Do not create branches, commits, worktrees, pull requests, push or publish anything.",
        "Do not modify the parent workspace or other agents' workspaces. Work only inside this workspace.",
        "Use the supplied MCP tools with the exact turn_id. Respect all approval requests.",
        "Make concrete changes relevant to your role, run tests appropriate to your changes and report actual results.",
        "The harness safely integrates non-conflicting changed files into the parent workspace when you finish. If the parent or another worker changed the same file differently, that file is not overwritten; the conflict is reported and your workspace is preserved.",
        "If your assignment overlaps another agent, focus on your named role and minimize edits outside that scope.",
        "Finish with a concise summary of files changed, tests and failures, and any suggested integration steps.",
        `USER-APPROVED SWARM OBJECTIVE\n${info.objective}`,
        `YOUR CURRENT ASSIGNMENT FROM THE ORCHESTRATOR\n${assignment}\n\nComplete this assignment within the shared objective. Do not independently take over other workers' tasks. Report concrete results, remaining dependencies and blockers so the orchestrator can decide the next step.`,
        "The orchestrator may change your role and assignment in a follow-up. Follow its latest instruction rather than keeping your initial specialization.",
      ].join("\n\n");
      this.recordChatMessage(agent, { id: newId("agent-user"), role: "user", text: assignment, createdAt: Date.now() });
      const answer = await this.sendWorker(agent, browser, prompt, controller.signal, { turnId });
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
        changedFiles: [...new Set([...(agent.info.changedFiles ?? []), ...integration.applied])],
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
        failurePhase: aborted ? undefined : error instanceof PickerPreparationError || error instanceof ConnectorAttachmentError ? "setup" : "work",
        finishedAt: Date.now(),
      };
    } finally {
      this.mcp.unregisterTurnContext(turnId);
      for (const approvalId of agent.approvalIds) {
        runtime.approvals.respond(approvalId, false);
      }
      runtime.approvals.denyAll();
      await runtime.exec.stopTurn(turnId).catch(() => undefined);
      runtime.timers.dispose();
      await runtime.externalMcp.close().catch(() => undefined);
      await runtime.exec.dispose().catch(() => undefined);
      agent.runtime = undefined;
      this.workerFinished(agent);
    }
  }

  private async sendWorker(agent: AgentRecord, browser: ChatGptBrowser, prompt: string, signal: AbortSignal, options: Parameters<ChatGptBrowser["send"]>[2]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const answer = await browser.send(prompt, signal, { ...options, onSubmitted: () => {
          agent.hasSubmittedTask = true;
          options?.onSubmitted?.();
        } });
        agent.hasSubmittedTask = true;
        return answer;
      }
      catch (error) {
        signal.throwIfAborted();
        // These typed errors occur before Send. Never replay a submitted
        // request or completed MCP action after an observation/transport error.
        if (!(error instanceof PickerPreparationError || error instanceof ConnectorAttachmentError) || attempt >= 2) throw error;
        agent.info = { ...agent.info, status: "preparing", activity: `Retrying browser setup (${attempt + 1}/2); no request was sent` };
        this.events.emit({ type: "notice", level: "warn", text: `Agent ${agent.info.id}: browser setup will retry before sending. ${error.message}` });
        this.publish();
        await delay(500, undefined, { signal });
        agent.info = { ...agent.info, status: "running", activity: "Preparing ChatGPT model and connector" };
      }
    }
  }
}

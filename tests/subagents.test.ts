import { describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { ChatGptBrowser, ConnectorAttachmentError } from "../src/browser/chatgpt.js";
import { HarnessEvents } from "../src/events.js";
import { McpHost } from "../src/mcp/server.js";
import { SubagentManager } from "../src/agent/subagents.js";
import type { SubagentSnapshot } from "../src/types.js";
import type { ToolContext } from "../src/tools/types.js";
import { findTool } from "../src/tools/index.js";

const turnContexts = new Map<string, ToolContext>();

function manager(open: boolean, connector = true): SubagentManager {
  const config = defaultConfig();
  config.browser.attachConnector = connector;
  const browser = { isOpen: open } as ChatGptBrowser;
  const mcp = {} as McpHost;
  return new SubagentManager(config, browser, mcp, new HarnessEvents());
}

function completion(events: HarnessEvents): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = events.on((event) => {
      if (event.type === "subagents" && event.agents.length > 0
        && (!event.orchestrator || ["complete", "blocked", "failed", "stopped"].includes(event.orchestrator.status))
        && event.agents.every((agent) => ["done", "failed", "stopped", "idle"].includes(agent.status))) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function browserFor(send: (prompt: string) => Promise<string>, review?: (prompt: string) => Promise<unknown>): ChatGptBrowser {
  const side = {
    isOpen: true,
    send,
    bringToFront: vi.fn(async () => undefined),
    snapshotBeforeTool: async () => undefined,
    closeSideChat: vi.fn(async () => undefined),
    stop: async () => undefined,
  };
  const coordinator = {
    ...side,
    closeSideChat: vi.fn(async () => undefined),
    send: async (prompt: string, signal: AbortSignal, options: { turnId: string }) => {
      const result = await (review ?? (async (prompt: string) => {
      const agents = JSON.parse(/CURRENT WORKER SNAPSHOT\n([^\n]+)/.exec(prompt)![1]!) as Array<{ id: string; conflicts?: string[] }>;
      const objective = /USER OBJECTIVE\n([\s\S]+?)\n\nAVAILABLE WORKERS/.exec(prompt)![1]!;
      const initial = prompt.includes("FIRST REVIEW:");
      return {
        status: initial ? "continue" : agents.some((agent) => agent.conflicts?.length) ? "blocked" : "complete",
        summary: initial ? "Assign specific work for the requested objective." : "Reviewed worker results and integration evidence.",
        assignments: initial ? agents.map((agent) => ({ id: agent.id, role: "Project-specific work", task: objective })) : [],
        instructions: [],
      };
    }))(prompt);
      if (signal.aborted || typeof result !== "object" || result === null) return String(result ?? "");
      const context = turnContexts.get(options.turnId);
      if (!context) throw new Error("Missing active MCP review context");
      const applied = await findTool("update_swarm")!.handler(result as Record<string, unknown>, context);
      if (applied.isError) throw new Error(JSON.stringify(applied.content));
      return "Review submitted through MCP.";
    },
  };
  let opened = false;
  return Object.assign({
    isOpen: true,
    openSideChat: async () => { if (!opened) { opened = true; return coordinator; } return side; },
  }, { sideChat: side }) as unknown as ChatGptBrowser;
}

function mcpHost(): McpHost {
  return {
    registerTurnContext: vi.fn((id: string, context: ToolContext) => { turnContexts.set(id, context); }),
    unregisterTurnContext: vi.fn((id: string) => { turnContexts.delete(id); }),
  } as unknown as McpHost;
}

describe("SubagentManager explicit launch boundaries", () => {
  it("ignores assistant JSON and prose, keeps planning after three missed MCP reviews, then accepts a real tool call", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-no-json-"));
    const source = path.join(temporaryHome, "project");
    await mkdir(source);
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "home"));
    let reviews = 0;
    const work = vi.fn(async () => "The assigned change is complete.");
    const plan = { status: "continue", summary: "A real MCP call must dispatch the only worker.", assignments: [{ id: "1", role: "Project work", task: "Implement and verify the requested storage change." }] };
    const browser = browserFor(work, async (prompt) => {
      reviews++;
      if (reviews === 1) return JSON.stringify(plan); // Text is deliberately not executable.
      if (reviews <= 3) return "Thinking\nThinking";
      expect(prompt).not.toContain("return a valid JSON");
      return reviews === 4 ? plan : { status: "complete", summary: "Reviewed the actual worker result and completed the change." };
    });
    const agents = new SubagentManager(defaultConfig(source), browser, mcpHost(), new HarnessEvents());
    vi.useFakeTimers();
    try {
      await agents.start(1, "Implement a small storage change");
      await vi.waitFor(() => expect(reviews).toBe(1));
      expect(work).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reviews).toBe(3);
      expect(agents.orchestration?.status).toBe("planning");
      expect(agents.snapshots[0]?.status).toBe("preparing");
      expect(agents.active).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(agents.orchestration?.status).toBe("complete"));
      expect(work).toHaveBeenCalledOnce();
    } finally {
      await agents.shutdown();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("retries connector setup without failing or launching unused workers", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-connector-"));
    const source = path.join(temporaryHome, "project");
    await mkdir(source);
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "home"));
    let reviews = 0;
    const work = vi.fn(async () => "The assigned work is complete.");
    const browser = browserFor(work, async () => {
      if (++reviews === 1) throw new ConnectorAttachmentError("Connector menu is still loading.");
      return reviews === 2
        ? { status: "continue", summary: "Connector is ready; start the concrete implementation.", assignments: [{ id: "1", role: "Implementation", task: "Implement and verify the requested storage change." }] }
        : { status: "complete", summary: "Reviewed the actual result after the connector recovered." };
    });
    const agents = new SubagentManager(defaultConfig(source), browser, mcpHost(), new HarnessEvents());
    vi.useFakeTimers();
    try {
      await agents.start(1, "Implement a small storage change");
      await vi.waitFor(() => expect(reviews).toBe(1));
      expect(agents.snapshots[0]?.status).toBe("preparing");
      expect(agents.orchestration?.status).toBe("planning");
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(agents.orchestration?.status).toBe("complete"));
      expect(work).toHaveBeenCalledOnce();
    } finally {
      await agents.shutdown();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("does not create workers on construction and can stop an empty group", async () => {
    const agents = manager(true);
    expect(agents.active).toBe(false);
    expect(agents.snapshots).toEqual([]);
    expect(() => agents.stop("all")).not.toThrow();
    await expect(agents.shutdown()).resolves.toBeUndefined();
  });

  it("enforces the hard limit of five explicitly requested workers", async () => {
    const agents = manager(true);
    await expect(agents.start(0, "test")).rejects.toThrow("1–5");
    await expect(agents.start(6, "test")).rejects.toThrow("1–5");
    await expect(agents.start(1.5, "test")).rejects.toThrow("1–5");
    expect(agents.snapshots).toEqual([]);
  });

  it("requires a task and a connected browser with tools", async () => {
    await expect(manager(true).start(1, "")).rejects.toThrow("Usage:");
    await expect(manager(false).start(1, "inspect code")).rejects.toThrow("Connect");
    await expect(manager(true, false).start(1, "inspect code")).rejects.toThrow("MCP");
  });

  it("rejects stopping an unknown worker without affecting the current group", () => {
    const agents = manager(true);
    expect(() => agents.stop("3")).toThrow("No subagent");
    expect(agents.snapshots).toEqual([]);
  });

  it("launches from an uncommitted non-Git folder and safely integrates isolated file changes", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-test-"));
    const source = path.join(temporaryHome, "project");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "uncommitted.txt"), "local uncommitted content");
    await writeFile(path.join(source, ".env"), "TOKEN=do-not-copy");
    await writeFile(path.join(source, ".env.example"), "TOKEN=replace-me");
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "harness-home"));
    const events = new HarnessEvents();
    const finished = completion(events);
    let agentWorkspace = "";
    const browser = browserFor(async (prompt) => {
      agentWorkspace = /^Workspace: (.+)$/m.exec(prompt)?.[1] ?? "";
      expect(agentWorkspace).not.toBe("");
      expect(await readFile(path.join(agentWorkspace, "uncommitted.txt"), "utf8")).toBe("local uncommitted content");
      await expect(lstat(path.join(agentWorkspace, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(agentWorkspace, ".env.example"), "utf8")).toBe("TOKEN=replace-me");
      await writeFile(path.join(agentWorkspace, "uncommitted.txt"), "edited by subagent");
      await writeFile(path.join(agentWorkspace, "new-file.txt"), "created by subagent");
      return "Updated uncommitted.txt and created new-file.txt. No Git operations were needed.";
    });
    const config = defaultConfig(source);
    config.browser.attachConnector = true;
    const agents = new SubagentManager(config, browser, mcpHost(), events);
    try {
      await agents.start(1, "Edit the project");
      await finished;
      const result = agents.snapshots[0]!;
      expect(result.status).toBe("done");
      expect("branch" in result).toBe(false);
      expect(result.changedFiles).toEqual(expect.arrayContaining(["uncommitted.txt", "new-file.txt"]));
      expect(result.conflicts).toEqual([]);
      expect(await readFile(path.join(source, "uncommitted.txt"), "utf8")).toBe("edited by subagent");
      expect(await readFile(path.join(source, "new-file.txt"), "utf8")).toBe("created by subagent");
      await expect(lstat(path.join(agentWorkspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await agents.shutdown();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("keeps completed child chats open and supports explicit focus and follow-up messages", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-chat-"));
    const source = path.join(temporaryHome, "project");
    await mkdir(source, { recursive: true });
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "harness-home"));
    const events = new HarnessEvents();
    const finished = completion(events);
    const sent: string[] = [];
    const browser = browserFor(async (prompt) => {
      sent.push(prompt);
      return sent.length === 1 ? "Initial child result." : "Follow-up child result.";
    }) as ChatGptBrowser & { sideChat: { bringToFront: ReturnType<typeof vi.fn>; closeSideChat: ReturnType<typeof vi.fn> } };
    const config = defaultConfig(source);
    config.browser.attachConnector = true;
    const agents = new SubagentManager(config, browser, mcpHost(), events);
    try {
      await agents.start(1, "Inspect the project");
      await finished;
      expect(agents.snapshots[0]?.status).toBe("done");
      expect(agents.snapshots[0]?.messages?.some((message) => message.role === "user" && message.text === "Inspect the project")).toBe(true);
      await agents.open("1");
      expect(browser.sideChat.bringToFront).toHaveBeenCalledOnce();
      await expect(agents.sendMessage("1", "Please verify the result again.")).resolves.toBe("Follow-up child result.");
      expect(agents.snapshots[0]?.status).toBe("done");
      expect(agents.snapshots[0]?.messages?.some((message) => message.role === "user" && message.text === "Please verify the result again.")).toBe(true);
      expect(sent).toHaveLength(2);
    } finally {
      await agents.shutdown();
      expect(browser.sideChat.closeSideChat).toHaveBeenCalledOnce();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("does not overwrite parent edits made while a subagent is working", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-conflict-"));
    const source = path.join(temporaryHome, "project");
    await mkdir(source, { recursive: true });
    const file = path.join(source, "shared.txt");
    await writeFile(file, "base");
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "harness-home"));
    const events = new HarnessEvents();
    const finished = completion(events);
    const browser = browserFor(async (prompt) => {
      const workspace = /^Workspace: (.+)$/m.exec(prompt)?.[1] ?? "";
      await writeFile(file, "edited by the parent");
      await writeFile(path.join(workspace, "shared.txt"), "edited by the subagent");
      return "Edited shared.txt.";
    });
    const config = defaultConfig(source);
    config.browser.attachConnector = true;
    const agents = new SubagentManager(config, browser, mcpHost(), events);
    try {
      await agents.start(1, "Edit shared.txt");
      await finished;
      const result = agents.snapshots[0]!;
      expect(result.status).toBe("done");
      expect(result.changedFiles).toEqual([]);
      expect(result.conflicts).toContain("shared.txt");
      expect(await readFile(file, "utf8")).toBe("edited by the parent");
    } finally {
      await agents.shutdown();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("lets the orchestrator choose assignments, review busy workers and queue useful corrections", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-supervision-"));
    const source = path.join(temporaryHome, "project");
    await mkdir(source);
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "home"));
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    let workCalls = 0;
    let reviews = 0;
    const workerPrompts: string[] = [];
    const browser = browserFor(async (prompt) => {
      workerPrompts.push(prompt);
      if (++workCalls === 1) await working;
      return "Concrete storage work and verification finished.";
    }, async (prompt) => {
      reviews += 1;
      if (reviews === 1) return { status: "continue", summary: "One worker should own the storage migration.", assignments: [{ id: "1", role: "Storage migration", task: "Implement a recoverable migration for project storage." }] };
      if (reviews === 2) return { status: "continue", summary: "The worker is still running; add the compatibility requirement.", instructions: [{ id: "1", message: "Also verify compatibility with the previous storage format." }] };
      const snapshots = JSON.parse(/CURRENT WORKER SNAPSHOT\n([^\n]+)/.exec(prompt)![1]!);
      return { status: snapshots.every((agent: SubagentSnapshot) => agent.status === "done") ? "complete" : "continue", summary: "Reviewed storage changes and compatibility verification evidence." };
    });
    const agents = new SubagentManager(defaultConfig(source), browser, mcpHost(), new HarnessEvents());
    vi.useFakeTimers();
    try {
      await agents.start(1, "Improve project storage");
      await vi.waitFor(() => expect(workCalls).toBe(1));
      expect(agents.snapshots[0]?.role).toBe("Storage migration");
      expect(workerPrompts[0]).toContain("Implement a recoverable migration");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reviews).toBe(2);
      expect(workCalls).toBe(1);
      expect(agents.snapshots[0]?.queuedInstructions).toEqual(["Also verify compatibility with the previous storage format."]);
      release();
      await vi.waitFor(() => expect(agents.orchestration?.status).toBe("complete"));
      expect(workCalls).toBe(2);
      expect(workerPrompts[1]).toContain("Also verify compatibility");
      expect(agents.active).toBe(false);
    } finally {
      release();
      await agents.shutdown();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("refreshes integrated parent files before an orchestrator-assigned dependent task", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-dependent-"));
    const source = path.join(temporaryHome, "project");
    await mkdir(source);
    await writeFile(path.join(source, "upstream.txt"), "initial");
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "home"));
    let reviews = 0;
    let calls = 0;
    let workspace = "";
    const browser = browserFor(async (prompt) => {
      if (++calls === 1) workspace = /^Workspace: (.+)$/m.exec(prompt)![1]!;
      else expect(await readFile(path.join(workspace, "upstream.txt"), "utf8")).toBe("integrated elsewhere");
      return "Verified the current project files.";
    }, async () => {
      reviews += 1;
      if (reviews === 2) await writeFile(path.join(source, "upstream.txt"), "integrated elsewhere");
      return {
        status: reviews < 3 ? "continue" : "complete", summary: "Reviewed current files and completed dependent verification.",
        assignments: reviews < 3 ? [{ id: "1", role: reviews === 1 ? "Data owner" : "Dependent verification", task: reviews === 1 ? "Inspect the project storage files." : "Verify the newly integrated upstream changes." }] : [],
      };
    });
    const agents = new SubagentManager(defaultConfig(source), browser, mcpHost(), new HarnessEvents());
    try {
      await agents.start(1, "Improve storage with verification");
      await agents.waitFor(5_000);
      expect(agents.orchestration?.status).toBe("complete");
      expect(agents.snapshots[0]?.role).toBe("Dependent verification");
      expect(calls).toBe(2);
    } finally {
      await agents.shutdown();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("cancels planning and never dispatches late assignments after stop all", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-stop-plan-"));
    await mkdir(path.join(temporaryHome, "project"));
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "home"));
    let finishPlanning!: (value: unknown) => void;
    let planning = false;
    const decision = new Promise<unknown>((resolve) => { finishPlanning = resolve; });
    const work = vi.fn(async () => "Work finished");
    const browser = browserFor(work, async () => { planning = true; return decision; });
    const agents = new SubagentManager(defaultConfig(path.join(temporaryHome, "project")), browser, mcpHost(), new HarnessEvents());
    try {
      await agents.start(1, "Improve the project");
      await vi.waitFor(() => expect(planning).toBe(true));
      agents.stop("all");
      await expect(agents.start(1, "Another task")).rejects.toThrow("already running");
      finishPlanning({ status: "continue", summary: "A late plan must not restart stopped work.", assignments: [{ id: "1", role: "Data work", task: "Implement the planned data migration." }] });
      await agents.shutdown();
      expect(work).not.toHaveBeenCalled();
      expect(agents.orchestration?.status).toBe("stopped");
      expect(agents.active).toBe(false);
    } finally {
      finishPlanning("{}");
      await agents.shutdown();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("lets the orchestrator keep unused capacity idle instead of inventing duplicate tasks", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-idle-"));
    await mkdir(path.join(temporaryHome, "project"));
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "home"));
    let reviews = 0;
    const work = vi.fn(async () => "Verified the small sequential change.");
    const browser = browserFor(work, async () => (++reviews === 1 ? {
      status: "continue", summary: "This small change is sequential; keep the second slot available.",
      assignments: [{ id: "1", role: "Storage change", task: "Implement and verify the single storage change." }],
      waiting: [{ id: "2", reason: "No independent work is available until the storage change finishes." }],
    } : { status: "complete", summary: "Reviewed the finished change; no additional parallel work was needed." }));
    const agents = new SubagentManager(defaultConfig(path.join(temporaryHome, "project")), browser, mcpHost(), new HarnessEvents());
    try {
      await agents.start(2, "Make a small storage change");
      await agents.waitFor(5_000);
      expect(work).toHaveBeenCalledOnce();
      expect(agents.snapshots).toHaveLength(2);
      expect(agents.snapshots[1]?.status).toBe("idle");
      expect(agents.orchestration?.status).toBe("complete");
      expect(agents.active).toBe(false);
    } finally {
      await agents.shutdown();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });
});

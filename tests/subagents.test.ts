import { describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { ChatGptBrowser } from "../src/browser/chatgpt.js";
import { HarnessEvents } from "../src/events.js";
import { McpHost } from "../src/mcp/server.js";
import { SubagentManager } from "../src/agent/subagents.js";

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
      if (event.type === "subagents" && event.agents.length > 0 && event.agents.every((agent) => ["done", "failed", "stopped"].includes(agent.status))) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function browserFor(send: (prompt: string) => Promise<string>): ChatGptBrowser {
  const side = {
    send,
    snapshotBeforeTool: async () => undefined,
    closeSideChat: async () => undefined,
    stop: async () => undefined,
  };
  return {
    isOpen: true,
    openSideChat: async () => side,
  } as unknown as ChatGptBrowser;
}

function mcpHost(): McpHost {
  return {
    registerTurnContext: vi.fn(),
    unregisterTurnContext: vi.fn(),
  } as unknown as McpHost;
}

describe("SubagentManager explicit launch boundaries", () => {
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
    vi.stubEnv("CHATGPT_CODER_HOME", path.join(temporaryHome, "harness-home"));
    const events = new HarnessEvents();
    const finished = completion(events);
    let agentWorkspace = "";
    const browser = browserFor(async (prompt) => {
      agentWorkspace = /^Workspace: (.+)$/m.exec(prompt)?.[1] ?? "";
      expect(agentWorkspace).not.toBe("");
      expect(await readFile(path.join(agentWorkspace, "uncommitted.txt"), "utf8")).toBe("local uncommitted content");
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
      expect(result.branch).toBeUndefined();
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
});

import { describe, expect, it } from "vitest";
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
});

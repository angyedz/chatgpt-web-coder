import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime/context.js";
import { HarnessEvents } from "../src/events.js";
import { McpHost } from "../src/mcp/server.js";
import { ChatGptBrowser } from "../src/browser/chatgpt.js";
import { SubagentManager } from "../src/agent/subagents.js";
import { PICKER_PAGE } from "./fixtures/picker-page.js";

it("starts the real coordinator and four real browser tabs with model, effort and connector setup, executes MCP edits and integrates results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-browser-"));
  const workspace = path.join(directory, "project");
  await mkdir(workspace);
  vi.stubEnv("CHATGPT_CODER_HOME", path.join(directory, "home"));
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(PICKER_PAGE); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  const config = defaultConfig(workspace);
  config.mcp.port = 0;
  config.approvalMode = "never";
  Object.assign(config.browser, { headless: true, channel: "chromium", baseUrl: `http://127.0.0.1:${address.port}`, userDataDir: path.join(directory, "profile"), useTemporaryChat: false, modelLabel: "GPT-6", effortLabel: "High", attachConnector: true });
  const runtime = createRuntime(config);
  const host = new McpHost(runtime.context, config.mcp);
  const client = new Client({ name: "browser-swarm-regression", version: "1.0.0" });
  const root = new ChatGptBrowser(config.browser, runtime.events);
  const agents = new SubagentManager(config, root, host, new HarnessEvents());
  const workers = new Set<string>();
  let coordinatorReviews = 0;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(await host.start())));
    await root.connect();
    // Full Chromium supports background targets in headless mode. Exercise the
    // production CDP branch used by headed sessions without showing OS windows.
    config.browser.headless = false;
    const primaryPage = root.currentPage!;
    const targets: Array<{ background?: boolean; focus?: boolean }> = [];
    const browser = primaryPage.context().browser()!;
    const newSession = browser.newBrowserCDPSession.bind(browser);
    vi.spyOn(browser, "newBrowserCDPSession").mockImplementation(async () => {
      const session = await newSession();
      const send = session.send.bind(session);
      vi.spyOn(session, "send").mockImplementation(((name: string, params: Record<string, unknown>) => {
        if (name === "Target.createTarget") targets.push(params);
        return send(name as "Target.createTarget", params as { url: string });
      }) as typeof session.send);
      return session;
    });
    await root.currentPage!.context().exposeBinding("respond", async (_source, prompt: string, model: string, effort: string) => {
      expect(model).toBe("GPT-6");
      expect(effort).toBe("High");
      const turnId = /Current harness turn_id \(required for tool calls\): (\S+)/.exec(prompt)![1]!;
      if (prompt.includes("CONTROL PROTOCOL:")) {
        coordinatorReviews++;
        const initial = prompt.includes("FIRST REVIEW:");
        const snapshot = agents.snapshots;
        const status = initial || snapshot.some((agent) => agent.status !== "done") ? "continue" : "complete";
        const assignments = initial ? snapshot.map((agent) => ({ id: agent.id, role: `Result owner ${agent.id}`, task: `Create and verify independent browser-result-${agent.id}.txt.` })) : [];
        let result = await client.callTool({ name: "update_swarm", arguments: { turn_id: turnId, status, summary: "Inspected the actual worker and integration state through the browser review.", assignments } });
        // Worker cleanup can finish just after its final result becomes visible.
        for (let retry = 0; result.isError && status === "complete" && retry < 10; retry++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          result = await client.callTool({ name: "update_swarm", arguments: { turn_id: turnId, status, summary: "Verified the final integrated files after worker cleanup." } });
        }
        expect(result.isError).not.toBe(true);
        return "Submitted the current review through MCP.";
      }
      const id = /Agent (\d) of/.exec(prompt)![1]!;
      expect(workers.has(id)).toBe(false);
      workers.add(id);
      const result = await client.callTool({ name: "apply_patch", arguments: { turn_id: turnId, patch: `*** Begin Patch\n*** Add File: browser-result-${id}.txt\n+worker ${id} used MCP\n*** End Patch` } });
      expect(result.isError).not.toBe(true);
      return `Created browser-result-${id}.txt using MCP.`;
    });
    await agents.start(4, "Produce four independent result files through MCP and review them");
    await agents.waitFor(75_000);
    expect(agents.orchestration?.status, JSON.stringify({ coordinator: agents.orchestration, agents: agents.snapshots })).toBe("complete");
    expect(workers.size).toBe(4);
    expect(root.currentPage).toBe(primaryPage);
    expect(targets).toHaveLength(5);
    expect(targets.every((target) => target.background === true && target.focus === false)).toBe(true);
    expect(coordinatorReviews).toBeGreaterThanOrEqual(2);
    expect(agents.snapshots.every((agent) => agent.status === "done" && agent.toolCount > 0)).toBe(true);
    for (const id of workers) expect(await readFile(path.join(workspace, `browser-result-${id}.txt`), "utf8")).toContain(`worker ${id} used MCP`);
    for (const page of root.currentPage!.context().pages()) {
      expect(await page.evaluate(() => (window as unknown as { wrongHits: number }).wrongHits)).toBe(0);
      expect(await page.locator('#effort-menu').isVisible()).toBe(false);
      expect(await page.locator('#models').isVisible()).toBe(false);
    }
  } finally {
    await agents.shutdown();
    await root.close();
    await client.close().catch(() => undefined);
    await host.stop();
    await runtime.exec.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";
import { createRuntime } from "../src/runtime/context.js";
import { McpHost } from "../src/mcp/server.js";
import { SubagentManager } from "../src/agent/subagents.js";
import type { ChatGptBrowser } from "../src/browser/chatgpt.js";

it("dispatches four workers through real MCP before coordinator prose finishes, rejects stale calls and integrates their MCP edits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-swarm-mcp-"));
  const workspace = path.join(directory, "project");
  await mkdir(workspace);
  vi.stubEnv("CHATGPT_CODER_HOME", path.join(directory, "home"));
  const config = defaultConfig(workspace);
  config.mcp.port = 0;
  config.approvalMode = "never";
  const root = createRuntime(config);
  const host = new McpHost(root.context, config.mcp);
  const client = new Client({ name: "swarm-regression", version: "1.0.0" });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let firstTurn = "";
  let reviewApplied = false;
  let opened = 0;
  const side = { isOpen: true, snapshotBeforeTool: async () => undefined, closeSideChat: async () => undefined, stop: async () => undefined };
  const browser = {
    isOpen: true,
    openSideChat: async () => {
      if (opened++ === 0) return { ...side, send: async (_prompt: string, _signal: AbortSignal, { turnId }: { turnId: string }) => {
        const initial = !firstTurn;
        if (initial) firstTurn = turnId;
        const arguments_ = initial ? {
          turn_id: turnId, status: "continue", summary: "Each worker creates a distinct scoped result file.",
          assignments: [1, 2, 3, 4].map((id) => ({ id: String(id), role: `Result ${id}`, task: `Create and verify the independent result file for worker ${id}.` })),
        } : { turn_id: turnId, status: "complete", summary: "Inspected all four integrated result files; all worker calls succeeded." };
        const result = await client.callTool({ name: "update_swarm", arguments: arguments_ });
        expect(result.isError).not.toBe(true);
        if (initial) {
          reviewApplied = true;
          const duplicate = await client.callTool({ name: "update_swarm", arguments: arguments_ });
          expect(duplicate.isError).toBe(true);
          await hold;
        }
        return "Assignments and review were submitted through MCP.";
      } };
      return { ...side, send: async (prompt: string, _signal: AbortSignal, { turnId }: { turnId: string }) => {
        const id = /Agent (\d) of/.exec(prompt)![1]!;
        const denied = await client.callTool({ name: "update_swarm", arguments: { turn_id: turnId, status: "blocked", summary: "Workers must not control the dedicated coordinator." } });
        expect(denied.isError).toBe(true);
        const result = await client.callTool({ name: "apply_patch", arguments: { turn_id: turnId, patch: `*** Begin Patch\n*** Add File: result-${id}.txt\n+result ${id}\n*** End Patch` } });
        expect(result.isError).not.toBe(true);
        return `Created result-${id}.txt through MCP.`;
      } };
    },
  } as unknown as ChatGptBrowser;
  const agents = new SubagentManager(config, browser, host, new HarnessEvents());
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(await host.start())));
    const wrongRoot = await client.callTool({ name: "update_swarm", arguments: { turn_id: "unknown", status: "blocked", summary: "A stale root call must not dispatch assignments." } });
    expect(wrongRoot.isError).toBe(true);
    await agents.start(4, "Create four independent result files and verify them");
    await vi.waitFor(() => expect(reviewApplied).toBe(true));
    await vi.waitFor(() => expect(agents.snapshots.every((agent) => agent.status === "done")).toBe(true));
    expect(agents.active).toBe(true); // Coordinator response has not ended yet.
    expect(agents.snapshots.every((agent) => agent.toolCount === 2)).toBe(true);
    for (let id = 1; id <= 4; id++) expect(await readFile(path.join(workspace, `result-${id}.txt`), "utf8")).toContain(`result ${id}`);
    release();
    await agents.waitFor(5_000);
    expect(agents.orchestration?.status).toBe("complete");
    const stale = await client.callTool({ name: "update_swarm", arguments: { turn_id: firstTurn, status: "continue", summary: "An expired review cannot change completed state." } });
    expect(stale.isError).toBe(true);
    expect(agents.orchestration?.status).toBe("complete");
  } finally {
    release();
    await agents.shutdown();
    await client.close().catch(() => undefined);
    await host.stop();
    await root.exec.dispose();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

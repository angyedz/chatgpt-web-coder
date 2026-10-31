import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { McpHost } from "../src/mcp/server.js";
import { createRuntime } from "../src/runtime/context.js";

let workspace: string;
let host: McpHost | undefined;
let client: Client | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "cc-mcp-"));
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await host?.stop().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe("MCP host", () => {
  it("lists tools and executes a call over Streamable HTTP", async () => {
    const config = defaultConfig(workspace);
    config.mcp.port = 0;
    config.approvalMode = "never";
    const runtime = createRuntime(config);
    host = new McpHost(runtime.context, config.mcp);
    const url = await host.start();

    const transport = new StreamableHTTPClientTransport(new URL(url));
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("exec_command");
    expect(names).toContain("apply_patch");
    expect(names).toContain("web_search");
    expect(names).toContain("update_plan");
    expect(names).toContain("set_timer");
    expect(names).toContain("start_background_task");
    expect(names).toContain("list_exec_sessions");

    const timer = await client.callTool({ name: "set_timer", arguments: { duration_ms: 60_000, label: "test timer" } });
    const timerText = (timer.content as Array<{ text?: string }>)[0]?.text ?? "";
    const timerId = /timer_[a-f0-9]+/.exec(timerText)?.[0];
    expect(timerId).toBeTruthy();
    const activeTimers = await client.callTool({ name: "list_timers", arguments: {} });
    expect(JSON.stringify(activeTimers.content)).toContain("test timer");
    await client.callTool({ name: "cancel_timer", arguments: { timer_id: timerId } });

    await writeFile(path.join(workspace, "hello.txt"), "hello mcp\n");
    const plan = await client.callTool({
      name: "update_plan",
      arguments: { steps: [{ step: "Inspect the workspace", status: "in_progress" }, { step: "Build", status: "pending" }] },
    });
    expect(JSON.stringify(plan.content)).toContain("Plan updated");
    const directory = await client.callTool({ name: "list_dir", arguments: { path: ".", depth: 1 } });
    expect(JSON.stringify(directory.content)).toContain("hello.txt");
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "hello.txt" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("hello mcp");

    const info = await client.callTool({
      name: "get_workspace_info",
      arguments: {},
    });
    const infoText = (info.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(infoText).toContain(workspace.replaceAll("\\", "\\\\"));
  });
});

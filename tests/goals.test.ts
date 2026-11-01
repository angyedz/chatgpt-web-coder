import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { Orchestrator } from "../src/agent/orchestrator.js";
import { McpHost } from "../src/mcp/server.js";
import { createRuntime } from "../src/runtime/context.js";
import { findTool } from "../src/tools/index.js";

describe("goal completion", () => {
  it("exposes update_goal through MCP and rejects completion until the plan is done", async () => {
    const config = defaultConfig(process.cwd());
    config.mcp.port = 0;
    const runtime = createRuntime(config);
    const host = new McpHost(runtime.context, config.mcp);
    const client = new Client({ name: "goal-test", version: "1.0.0" });
    try {
      const url = await host.start();
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("update_goal");
      runtime.goal.start("Finish the work");
      runtime.plan.update([{ step: "Finish the work", status: "in_progress" }]);
      const arguments_ = { status: "complete", detail: "The work is fully complete." };
      const rejected = await client.callTool({ name: "update_goal", arguments: arguments_ });
      expect(rejected.isError).toBe(true);
      expect(runtime.goal.current?.status).toBe("active");
      runtime.plan.update([{ step: "Finish the work", status: "completed" }]);
      const result = await client.callTool({ name: "update_goal", arguments: arguments_ });
      expect(result.isError).not.toBe(true);
      expect(runtime.goal.current).toMatchObject({ status: "complete", detail: arguments_.detail });
    } finally {
      await client.close().catch(() => undefined);
      await host.stop().catch(() => undefined);
    }
  });

  it("asks ChatGPT to continue until it invokes the completion tool", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-goal-test-"));
    vi.stubEnv("CHATGPT_CODER_HOME", temporaryHome);
    const orchestrator = new Orchestrator(defaultConfig(temporaryHome));
    try {
      const updateGoal = findTool("update_goal");
      expect(updateGoal).toBeDefined();
      const send = vi.spyOn(orchestrator.browser, "send")
        .mockResolvedValueOnce("The work is done.")
        .mockImplementationOnce(async () => {
          const result = await updateGoal!.handler({ status: "complete", detail: "The requested work is complete." }, orchestrator.runtime.context);
          expect(result.isError).not.toBe(true);
          return "The requested work is complete.";
        });
      await orchestrator.submit("/goal Finish the work");
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]?.[0]).toContain("call update_goal with status complete");
      expect(send.mock.calls[1]?.[0]).toContain("call update_goal with complete");
      expect(orchestrator.runtime.goal.current?.status).toBe("complete");
      expect(orchestrator.isBusy).toBe(false);
    } finally {
      await orchestrator.sessions.flush();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });
});

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
import { GoalStore } from "../src/runtime/goals.js";
import { HarnessEvents } from "../src/events.js";

describe("goal completion", () => {
  it("waits for an active swarm without counting quiet root turns as lack of progress", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-goal-swarm-"));
    vi.stubEnv("CHATGPT_CODER_HOME", temporaryHome);
    const orchestrator = new Orchestrator(defaultConfig(temporaryHome));
    let swarmActive = true;
    vi.spyOn(orchestrator.subagents, "active", "get").mockImplementation(() => swarmActive);
    const send = vi.spyOn(orchestrator.browser, "send").mockResolvedValueOnce("Workers are running.").mockImplementationOnce(async () => {
      await findTool("update_goal")!.handler({ status: "complete", detail: "Reviewed all integrated swarm results." }, orchestrator.runtime.context);
      return "The requested work is complete.";
    });
    try {
      const submission = orchestrator.submit("/goal Finish the delegated work");
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(orchestrator.runtime.goal.current?.status).toBe("active");
      expect(orchestrator.isBusy).toBe(true);
      swarmActive = false;
      await submission;
      expect(send).toHaveBeenCalledTimes(2);
      expect(orchestrator.runtime.goal.current?.status).toBe("complete");
    } finally {
      swarmActive = false;
      await orchestrator.sessions.flush();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("keeps the goal active when three continuations have no tool actions", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-goal-no-tools-"));
    vi.stubEnv("CHATGPT_CODER_HOME", temporaryHome);
    const orchestrator = new Orchestrator(defaultConfig(temporaryHome));
    vi.spyOn(orchestrator.browser, "send").mockResolvedValue("No MCP actions were performed.");
    try {
      await orchestrator.submit("/goal Finish the work");
      expect(orchestrator.runtime.goal.current?.status).toBe("active");
      expect(orchestrator.isBusy).toBe(false);
    } finally {
      await orchestrator.sessions.flush();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("exposes update_goal through MCP and rejects completion until the plan is done", async () => {
    const config = defaultConfig(process.cwd());
    config.mcp.port = 0;
    const runtime = createRuntime(config);
    runtime.context.turnId = "goal-test-turn";
    runtime.context.turnSignal = new AbortController().signal;
    const host = new McpHost(runtime.context, config.mcp);
    const client = new Client({ name: "goal-test", version: "1.0.0" });
    try {
      const url = await host.start();
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("update_goal");
      runtime.goal.start("Finish the work");
      runtime.plan.update([{ step: "Finish the work", status: "in_progress" }]);
      const arguments_ = { status: "complete", detail: "The work is fully complete.", turn_id: runtime.context.turnId };
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
  it("does not pause or cancel the whole goal when one approval is denied or times out", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-goal-approval-"));
    vi.stubEnv("CHATGPT_CODER_HOME", temporaryHome);
    const orchestrator = new Orchestrator(defaultConfig(temporaryHome));
    const stop = vi.spyOn(orchestrator.browser, "stop").mockResolvedValue();
    try {
      orchestrator.runtime.goal.start("Finish the project");
      orchestrator.events.emit({ type: "approval-resolved", id: "approval-denied", allowed: false });
      orchestrator.events.emit({ type: "approval-resolved", id: "approval-timeout", allowed: false });
      expect(orchestrator.runtime.goal.current?.status).toBe("active");
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await orchestrator.sessions.flush();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  it("preserves an active goal after a browser transport failure", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-goal-error-"));
    vi.stubEnv("CHATGPT_CODER_HOME", temporaryHome);
    const orchestrator = new Orchestrator(defaultConfig(temporaryHome));
    vi.spyOn(orchestrator.browser, "send").mockRejectedValue(new Error("temporary browser transport failure"));
    try {
      await orchestrator.submit("/goal Finish the project");
      expect(orchestrator.runtime.goal.current?.status).toBe("active");
      expect(orchestrator.runtime.goal.current?.status).not.toBe("paused");
      expect(orchestrator.isBusy).toBe(false);
    } finally {
      await orchestrator.sessions.flush();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

});


describe("goal pause ownership", () => {
  it("only enters paused through an explicit user pause", () => {
    const goal = new GoalStore(new HarnessEvents());
    goal.start("Keep working");
    expect(() => goal.setStatus("paused", "unexpected")).toThrow("explicit user pause");
    expect(goal.current?.status).toBe("active");
    goal.pauseByUser();
    expect(goal.current?.status).toBe("paused");
  });

  it("marks an unowned abort as blocked rather than silently pausing", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "cc-goal-abort-"));
    vi.stubEnv("CHATGPT_CODER_HOME", temporaryHome);
    const orchestrator = new Orchestrator(defaultConfig(temporaryHome));
    vi.spyOn(orchestrator.browser, "send").mockImplementation(async () => {
      (orchestrator as unknown as { currentTurn?: AbortController }).currentTurn?.abort();
      throw new DOMException("unexpected abort", "AbortError");
    });
    try {
      await orchestrator.submit("/goal Keep working");
      expect(orchestrator.runtime.goal.current?.status).toBe("blocked");
      expect(orchestrator.runtime.goal.current?.detail).toContain("without an explicit user pause");
    } finally {
      await orchestrator.sessions.flush();
      vi.unstubAllEnvs();
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });
});

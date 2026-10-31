import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";
import { createRuntime } from "../src/runtime/context.js";
import { parseDuration, TimerManager } from "../src/runtime/timers.js";
import { scheduleTimer } from "../src/runtime/schedule.js";
import { findTool } from "../src/tools/index.js";
import { Orchestrator } from "../src/agent/orchestrator.js";

afterEach(() => vi.useRealTimers());

describe("timers and background tasks", () => {
  it("parses durations and rejects malformed or out-of-range values", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("2м30с")).toBe(150_000);
    expect(parseDuration("5minutes")).toBeUndefined();
    expect(parseDuration("0s")).toBeUndefined();
    expect(parseDuration("100d")).toBeUndefined();
  });

  it("fires once, reports its label, and never runs a cancelled timer", async () => {
    vi.useFakeTimers();
    const events = new HarnessEvents();
    const notices: string[] = [];
    events.on((event) => { if (event.type === "notice") notices.push(event.text); });
    const timers = new TimerManager(events);
    const callback = vi.fn(async () => undefined);
    const cancelled = timers.schedule(1000, "cancel me", callback);
    timers.schedule(2000, "reminder", callback);
    expect(timers.cancel(cancelled.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(notices.some((notice) => notice.includes("reminder"))).toBe(true);
    expect(timers.list()).toHaveLength(0);
    timers.dispose();
  });

  it("starts scheduled commands as background sessions and cancels pending commands", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime(defaultConfig(process.cwd()));
    const run = vi.spyOn(runtime.exec, "run").mockResolvedValue({ output: "", running: true, sessionId: "exec_123", durationMs: 250 });
    const cancelled = scheduleTimer(runtime.context, 1000, "cancelled", "should-not-run");
    runtime.timers.cancel(cancelled.id);
    scheduleTimer(runtime.context, 2000, "server", "npm run dev");
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("npm run dev", expect.objectContaining({ background: true, workdir: runtime.context.workspace }));
    runtime.timers.dispose();
  });

  it("runs another tool as a background task and exposes its result", async () => {
    const config = defaultConfig(process.cwd());
    config.approvalMode = "never";
    const runtime = createRuntime(config);
    const start = findTool("start_background_task")!;
    const started = await start.handler({ tool_name: "get_workspace_info", arguments: {} }, runtime.context);
    const id = /task_[a-zA-Z0-9]+/.exec(started.content[0]?.type === "text" ? started.content[0].text : "")?.[0];
    expect(id).toBeTruthy();
    await vi.waitFor(() => expect(runtime.tasks.get(id!)?.status).toBe("completed"));
    const result = await findTool("get_background_task")!.handler({ task_id: id }, runtime.context);
    expect(result.content.some((item) => item.type === "text" && item.text.includes(config.workspace.replaceAll("\\", "\\\\")))).toBe(true);
    const invalid = await start.handler({ tool_name: "get_workspace_info", arguments: { unexpected: true } }, runtime.context);
    expect(invalid.isError).toBe(true);
  });

  it("keeps background approval requests when cancelling foreground work", async () => {
    const runtime = createRuntime(defaultConfig(process.cwd()));
    runtime.approvals.mode = "ask";
    const foreground = runtime.approvals.request("fg", {}, "foreground");
    const background = runtime.approvals.request("bg", {}, "background", 70_000, "task_1");
    runtime.approvals.denyForeground();
    expect((await foreground).allowed).toBe(false);
    expect(runtime.approvals.pendingRequests).toHaveLength(1);
    runtime.approvals.respond(runtime.approvals.pendingRequests[0]!.id, true);
    expect((await background).allowed).toBe(true);
  });

  it("asks for approval before scheduling a command through the agent", async () => {
    const runtime = createRuntime(defaultConfig(process.cwd()));
    runtime.approvals.mode = "ask";
    const pending = findTool("set_timer")!.handler({ duration_ms: 1000, command: "npm run dev" }, runtime.context);
    expect(runtime.timers.list()).toHaveLength(0);
    const request = runtime.approvals.pendingRequests[0];
    expect(request?.summary).toContain("npm run dev");
    runtime.approvals.respond(request!.id, false);
    expect((await pending).isError).toBe(true);
    expect(runtime.timers.list()).toHaveLength(0);
  });

  it("supports creating, listing and cancelling timers from the harness", async () => {
    vi.useFakeTimers();
    const orchestrator = new Orchestrator(defaultConfig(process.cwd()));
    const notices: string[] = [];
    orchestrator.events.on((event) => { if (event.type === "notice" || event.type === "system-message") notices.push(event.text); });
    await orchestrator.submit("/timer 2m coffee");
    await orchestrator.submit("/timer 5m -- npm run dev");
    const timers = orchestrator.runtime.timers.list();
    expect(timers.map((timer) => timer.label)).toEqual(["coffee", "npm run dev"]);
    expect(timers[1]?.command).toBe("npm run dev");
    await orchestrator.submit("/timers");
    expect(notices.at(-1)).toContain("coffee");
    await orchestrator.submit(`/timer cancel ${timers[0]!.id}`);
    expect(orchestrator.runtime.timers.list()).toHaveLength(1);
    orchestrator.runtime.timers.dispose();
  });

  it("runs a background exec tool without stopping its process at turn cancellation", async () => {
    const config = defaultConfig(process.cwd());
    config.approvalMode = "never";
    const runtime = createRuntime(config);
    try {
      const result = await findTool("start_background_task")!.handler({
        tool_name: "exec_command",
        arguments: { cmd: 'node -e "console.log(\'job ready\'); setInterval(()=>{},1000)"' },
      }, runtime.context);
      const id = /task_[a-f0-9]+/.exec(result.content[0]?.type === "text" ? result.content[0].text : "")?.[0];
      await vi.waitFor(() => expect(runtime.tasks.get(id!)?.status).toBe("completed"), { timeout: 10_000 });
      const session = runtime.exec.list().find((job) => job.background && job.running);
      expect(session).toBeDefined();
      await runtime.exec.stopForeground();
      expect(runtime.exec.inspect(session!.id)?.running).toBe(true);
      expect(await runtime.exec.kill(session!.id)).toBe(true);
    } finally {
      runtime.timers.dispose();
      await runtime.exec.dispose();
    }
  }, 20_000);
});

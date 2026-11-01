import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/agent/orchestrator.js";
import { defaultConfig } from "../src/config.js";
import type { HarnessEvent } from "../src/types.js";

describe("turn cancellation", () => {
  it("stops a turn once even when cancel is pressed repeatedly", async () => {
    const orchestrator = new Orchestrator(defaultConfig(process.cwd()));
    const events: HarnessEvent[] = [];
    orchestrator.events.on((event) => events.push(event));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const send = vi.spyOn(orchestrator.browser, "send").mockImplementation(async (_prompt, signal) => {
      started();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const stop = vi.spyOn(orchestrator.browser, "stop").mockResolvedValue();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const dispose = vi.spyOn(orchestrator.runtime.exec, "stopTurn").mockReturnValue(cleanup);

    const turn = orchestrator.submit("hello");
    await ready;
    for (let index = 0; index < 200; index += 1) orchestrator.cancel();
    await Promise.resolve();
    expect(orchestrator.isBusy).toBe(true);
    finishCleanup();
    await turn;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "phase" && event.phase === "cancelling")).toHaveLength(1);
    expect(events.filter((event) => event.type === "notice" && event.text === "Turn cancelled.")).toHaveLength(1);
    expect(orchestrator.isBusy).toBe(false);

    send.mockResolvedValueOnce("done");
    await orchestrator.submit("next turn");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

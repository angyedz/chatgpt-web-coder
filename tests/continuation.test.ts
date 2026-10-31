import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { Orchestrator } from "../src/agent/orchestrator.js";
import type { HarnessEvent } from "../src/types.js";

describe("continuing an unfinished plan", () => {
  it("continues in the same chat only after the browser has stopped at a tool", async () => {
    const orchestrator = new Orchestrator(defaultConfig(process.cwd()));
    const send = vi.spyOn(orchestrator.browser, "send")
      .mockImplementationOnce(async () => {
        orchestrator.runtime.plan.update([{ step: "Build the site", status: "in_progress" }]);
        return "I will inspect the project.";
      })
      .mockImplementationOnce(async () => {
        orchestrator.runtime.plan.update([{ step: "Build the site", status: "completed" }]);
        return "The site is ready.";
      });
    vi.spyOn(orchestrator.browser, "responseEndedAfterTool", "get").mockReturnValueOnce(true).mockReturnValue(false);
    await orchestrator.submit("Build a site");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toContain("Continue the same user request");
    expect(send.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ continueChat: true, canRecoverStall: expect.any(Function) }));
    expect(orchestrator.isBusy).toBe(false);
  });

  it("stops retrying and reports an unfinished plan after two continuations", async () => {
    const orchestrator = new Orchestrator(defaultConfig(process.cwd()));
    const events: HarnessEvent[] = [];
    orchestrator.events.on((event) => events.push(event));
    const send = vi.spyOn(orchestrator.browser, "send").mockImplementation(async () => {
      orchestrator.runtime.plan.update([{ step: "Build the site", status: "in_progress" }]);
      return "";
    });
    vi.spyOn(orchestrator.browser, "responseEndedAfterTool", "get").mockReturnValue(true);
    await orchestrator.submit("Build a site");
    expect(send).toHaveBeenCalledTimes(3);
    expect(events.some((event) => event.type === "turn-end" && !event.ok)).toBe(true);
    expect(events.some((event) => event.type === "notice" && event.level === "warn" && event.text.includes("unfinished"))).toBe(true);
  });

  it("does not continue when ChatGPT responded with a question or blocker", async () => {
    const orchestrator = new Orchestrator(defaultConfig(process.cwd()));
    const send = vi.spyOn(orchestrator.browser, "send").mockImplementation(async () => {
      orchestrator.runtime.plan.update([{ step: "Build the site", status: "in_progress" }]);
      return "Which payment provider should I use?";
    });
    vi.spyOn(orchestrator.browser, "responseEndedAfterTool", "get").mockReturnValue(false);
    await orchestrator.submit("Build a site");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

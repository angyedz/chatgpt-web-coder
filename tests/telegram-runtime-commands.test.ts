import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime/context.js";
import { SessionStore } from "../src/runtime/sessions.js";
import { runRemoteRuntimeCommand } from "../src/telegram/runtime-commands.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-runtime-"));
  roots.push(root);
  vi.stubEnv("CHATGPT_CODER_HOME", path.join(root, "home"));
  const folder = path.join(root, "selected");
  await mkdir(folder);
  const store = new SessionStore(folder, () => undefined);
  await store.initialize();
  const runtime = createRuntime(defaultConfig(folder));
  return { store, runtime };
}

describe("Telegram selected workspace runtime commands", () => {
  it("schedules, lists and cancels real timers, persisting the selected session snapshot", async () => {
    const { store, runtime } = await setup();
    try {
      const result = await runRemoteRuntimeCommand("timer", "5m build reminder", runtime, store);
      const id = runtime.timers.list()[0]?.id;
      expect(result).toContain("selected project");
      expect(id).toBeDefined();
      expect((await store.list())[0]?.timers.map((timer) => timer.id)).toContain(id);
      expect(await runRemoteRuntimeCommand("timers", "", runtime, store)).toContain(id);
      expect(await runRemoteRuntimeCommand("timer", "cancel " + id, runtime, store)).toContain("Cancelled");
      expect(runtime.timers.list()).toHaveLength(0);
      expect((await store.list())[0]?.timers).toHaveLength(0);
    } finally {
      runtime.timers.dispose();
      await runtime.exec.dispose();
    }
  });

  it("inspects and stops only the selected runtime jobs", async () => {
    const { store, runtime } = await setup();
    try {
      vi.spyOn(runtime.exec, "list").mockReturnValue([{
        id: "job-123", command: "npm test", workdir: store.snapshot.workspace,
        running: true, background: true, timedOut: false, tail: "tests green", startedAt: 1,
      }]);
      vi.spyOn(runtime.exec, "inspect").mockReturnValue({
        id: "job-123", command: "npm test", workdir: store.snapshot.workspace,
        running: true, background: true, timedOut: false, tail: "tests green", startedAt: 1,
      });
      vi.spyOn(runtime.exec, "kill").mockResolvedValue(true);
      expect(await runRemoteRuntimeCommand("jobs", "", runtime, store)).toContain("job-123");
      expect(await runRemoteRuntimeCommand("job", "job-123", runtime, store)).toContain("tests green");
      expect(await runRemoteRuntimeCommand("job", "stop job-123", runtime, store)).toContain("Stopped");
      expect(runtime.exec.kill).toHaveBeenCalledWith("job-123");
      expect(store.snapshot.jobs[0]?.description).toBe("npm test");
    } finally {
      runtime.timers.dispose();
      await runtime.exec.dispose();
    }
  });
});

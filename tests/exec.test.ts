import { describe, expect, it } from "vitest";
import { ExecSessionManager } from "../src/tools/exec.js";

describe("ExecSessionManager", () => {
  it("runs a command and captures output", async () => {
    const manager = new ExecSessionManager();
    const result = await manager.run('node -e "console.log(1 + 1)"', {
      yieldTimeMs: 8000,
    });
    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("2");
    await manager.dispose();
  });

  it("returns a session for a long command and can poll it", async () => {
    const manager = new ExecSessionManager();
    const first = await manager.run(
      'node -e "console.log(\'start\'); setTimeout(() => console.log(\'done\'), 1200)"',
      { yieldTimeMs: 200 },
    );

    expect(first.running).toBe(true);
    expect(first.sessionId).toBeTruthy();

    let output = first.output;
    let running = true;
    const deadline = Date.now() + 15_000;
    while (running && Date.now() < deadline) {
      const next = await manager.write(first.sessionId!, "", 500);
      output += next.output;
      running = next.running;
    }

    expect(running).toBe(false);
    expect(output).toContain("start");
    expect(output).toContain("done");
    await manager.dispose();
  });

  it("keeps background commands alive when foreground commands are stopped", async () => {
    const manager = new ExecSessionManager();
    try {
      const background = await manager.run('node -e "console.log(\'background ready\'); setInterval(()=>{}, 1000)"', { background: true, yieldTimeMs: 600 });
      const foreground = await manager.run('node -e "setInterval(()=>{}, 1000)"', { yieldTimeMs: 400 });
      expect(background.sessionId).toBeTruthy();
      expect(foreground.sessionId).toBeTruthy();
      await manager.stopForeground();
      expect(manager.inspect(background.sessionId!)?.running).toBe(true);
      expect(manager.inspect(foreground.sessionId!)).toBeUndefined();
      expect(manager.inspect(background.sessionId!)?.tail).toContain("background ready");
      expect(await manager.kill(background.sessionId!)).toBe(true);
    } finally {
      await manager.dispose();
    }
  }, 20_000);

  it("ends a command after its deadline", async () => {
    const manager = new ExecSessionManager();
    try {
      const result = await manager.run('node -e "setInterval(()=>{}, 1000)"', { timeoutMs: 500, yieldTimeMs: 5000 });
      expect(result.running).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.output).toContain("timed out");
    } finally {
      await manager.dispose();
    }
  }, 20_000);
});

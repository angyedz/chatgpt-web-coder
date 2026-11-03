import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../src/runtime/sessions.js";
import { TelegramSessionBridge } from "../src/telegram/sessions.js";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";
import type { SavedSession } from "../src/runtime/sessions.js";
import type { ChatGptBrowser } from "../src/browser/chatgpt.js";
import type { McpHost } from "../src/mcp/server.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), "tg-session-test-"));
  roots.push(home);
  vi.stubEnv("CHATGPT_CODER_HOME", path.join(home, "home"));
  const alpha = path.join(home, "alpha");
  const beta = path.join(home, "beta");
  await mkdir(alpha);
  await mkdir(beta);
  const storeA = new SessionStore(alpha, () => undefined);
  await storeA.initialize();
  const storeB = new SessionStore(beta, () => undefined);
  await storeB.initialize();
  await storeA.flush();
  await storeB.flush();
  return { home, alpha, beta, storeA, storeB };
}

describe("Telegram saved chat routing", () => {
  it("indexes chats from every project folder and retains the original active session pointers", async () => {
    const { alpha, beta, storeA, storeB, home } = await setup();
    const originalActive = await readFile(path.join(home, "home", "sessions", (await import("node:crypto")).createHash("sha256").update(alpha).digest("hex").slice(0, 20), "active"), "utf8");
    const all = await SessionStore.listAll();
    expect(all.map((item) => item.workspace)).toEqual(expect.arrayContaining([alpha, beta]));
    expect(all.map((item) => item.id)).toEqual(expect.arrayContaining([storeA.id, storeB.id]));

    const detached = new SessionStore(alpha, () => undefined);
    await detached.loadDetached(storeA.id);
    await detached.createDetached();
    expect(detached.snapshot.workspace).toBe(alpha);
    expect(detached.id).not.toBe(storeA.id);
    const stillActive = await readFile(path.join(home, "home", "sessions", (await import("node:crypto")).createHash("sha256").update(alpha).digest("hex").slice(0, 20), "active"), "utf8");
    expect(stillActive).toBe(originalActive);
    expect((await SessionStore.listAll()).some((item) => item.id === detached.id)).toBe(true);
  });

  it("routes the selected foreign session to a background tab without changing the root chat", async () => {
    const { alpha, beta, storeA, storeB } = await setup();
    const config = defaultConfig(alpha);
    config.browser.attachConnector = true;
    const sideEvents = new HarnessEvents();
    let emitted: string[] = [];
    const sideBrowser = {
      send: vi.fn(async (_message: string, _signal: AbortSignal, options: { turnId: string }) => {
        sideEvents.emit({ type: "assistant-start", id: "assistant-tg", channel: "telegram" });
        sideEvents.emit({ type: "assistant-delta", id: "assistant-tg", text: "Reply for beta folder", channel: "telegram" });
        sideEvents.emit({ type: "assistant-done", id: "assistant-tg", text: "Reply for beta folder", channel: "telegram" });
        return "Reply for beta folder";
      }),
      setResponseChannel: vi.fn(),
      closeSideChat: vi.fn(async () => undefined),
      snapshotBeforeTool: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const browser = {
      isOpen: true,
      openSideChat: vi.fn(async () => sideBrowser),
    } as unknown as ChatGptBrowser;
    const mcp = {
      registerTurnContext: vi.fn(),
      unregisterTurnContext: vi.fn(),
    } as unknown as McpHost;
    const mainSubmit = vi.fn(() => true);
    const bridge = new TelegramSessionBridge(
      config, browser, mcp,
      () => storeA.snapshot, () => false, () => "idle",
      mainSubmit, vi.fn(), (event) => emitted.push(event.type),
    );
    try {
      const choice = await bridge.choose(storeB.id);
      expect(choice.workspace).toBe(beta);
      expect(bridge.isRootSelected).toBe(false);
      expect(bridge.submit("Work in beta")).toBe(true);
      for (let i = 0; i < 100 && bridge.busy; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mainSubmit).not.toHaveBeenCalled();
      expect(sideBrowser.send).toHaveBeenCalledTimes(1);
      expect(mcp.registerTurnContext).toHaveBeenCalledTimes(1);
      expect(mcp.unregisterTurnContext).toHaveBeenCalledTimes(1);
      expect(emitted).toContain("assistant-delta");
      expect(storeA.snapshot.messages).toHaveLength(0);
      expect((await SessionStore.listAll()).find((item) => item.id === storeB.id)?.messages.some((item) => item.text === "Reply for beta folder")).toBe(true);
    } finally {
      await bridge.shutdown();
    }
  });
});

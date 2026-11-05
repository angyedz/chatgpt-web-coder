import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  it("creates isolated chats in a new absolute project folder without changing the local active pointer", async () => {
    const { home, alpha, storeA } = await setup();
    const config = defaultConfig(alpha);
    const rootCommand = vi.fn(async (command: string) => "Executed " + command);
    const bridge = new TelegramSessionBridge(
      config, { isOpen: false } as ChatGptBrowser, {} as McpHost,
      () => storeA.snapshot, () => false, () => "idle",
      vi.fn(() => true), vi.fn(), vi.fn(), rootCommand,
    );
    try {
      const folder = path.join(home, "new-folder", "nested project");
      await expect(bridge.create(folder)).rejects.toThrow();
      const created = await bridge.create('--create "' + folder + '"');
      expect(created.workspace).toBe(await realpath(folder));
      expect(created.id).not.toBe(storeA.id);
      expect(bridge.isRootSelected).toBe(false);
      const another = await bridge.create(folder);
      expect(another.id).not.toBe(created.id);
      expect(storeA.id).not.toBe(another.id);
      expect((await bridge.list()).map((entry) => entry.id)).toEqual(expect.arrayContaining([created.id, another.id, storeA.id]));
      await expect(bridge.create("relative-folder")).rejects.toThrow("absolute");
    } finally { await bridge.shutdown(); }
  });

  it("keeps session commands scoped to the selected Telegram chat and routes global commands to harness", async () => {
    const { alpha, storeA, storeB } = await setup();
    const rootCommand = vi.fn(async (command: string) => "Harness replied to " + command);
    const bridge = new TelegramSessionBridge(
      defaultConfig(alpha), { isOpen: false } as ChatGptBrowser, {} as McpHost,
      () => storeA.snapshot, () => false, () => "idle",
      vi.fn(() => true), vi.fn(), vi.fn(), rootCommand,
    );
    try {
      await bridge.choose(storeB.id);
      expect(await bridge.command("/session rename Beta renamed")).toContain("Beta renamed");
      expect((await SessionStore.listAll()).find((s) => s.id === storeB.id)?.title).toBe("Beta renamed");
      expect(storeA.snapshot.title).toBe("New session");
      expect(await bridge.command("/session info")).toContain(storeB.snapshot.workspace);
      expect(await bridge.command("/status")).toContain(storeB.id);
      expect(rootCommand).not.toHaveBeenCalled();
      expect(await bridge.command("/update check")).toContain("[Main harness / global command");
      expect(rootCommand).toHaveBeenCalledWith("/update check");
    } finally { await bridge.shutdown(); }
  });


  it("indexes chats from every project folder and retains the original active session pointers", async () => {
    const { alpha, beta, storeA, storeB, home } = await setup();
    const folderKey = (await import("node:crypto")).createHash("sha256").update(process.platform === "win32" ? path.resolve(alpha).toLowerCase() : path.resolve(alpha)).digest("hex").slice(0, 20);
    const originalActive = await readFile(path.join(home, "home", "sessions", folderKey, "active"), "utf8");
    const all = await SessionStore.listAll();
    expect(all.map((item) => item.workspace)).toEqual(expect.arrayContaining([alpha, beta]));
    expect(all.map((item) => item.id)).toEqual(expect.arrayContaining([storeA.id, storeB.id]));

    const detached = new SessionStore(alpha, () => undefined);
    await detached.loadDetached(storeA.id);
    await detached.createDetached();
    expect(detached.snapshot.workspace).toBe(alpha);
    expect(detached.id).not.toBe(storeA.id);
    const stillActive = await readFile(path.join(home, "home", "sessions", folderKey, "active"), "utf8");
    expect(stillActive).toBe(originalActive);
    expect((await SessionStore.listAll()).some((item) => item.id === detached.id)).toBe(true);
  });

  it("runs a goal in the selected project session without touching the foreground goal", async () => {
    const { alpha, storeA, storeB } = await setup();
    let bridge!: TelegramSessionBridge;
    const browser = {
      isOpen: true,
      openSideChat: vi.fn(async () => ({
        isOpen: true, send: vi.fn(async () => {
          const worker = (bridge as unknown as { workers: Map<string, { runtime?: { goal: { setStatus(status: "complete", detail: string): void } } }> }).workers.get(storeB.id);
          worker?.runtime?.goal.setStatus("complete", "Verified in the selected workspace.");
          return "Goal checked";
        }),
        setResponseChannel: vi.fn(), snapshotBeforeTool: vi.fn(), closeSideChat: vi.fn(), stop: vi.fn(),
      })),
    } as unknown as ChatGptBrowser;
    bridge = new TelegramSessionBridge(
      defaultConfig(alpha), browser, { registerTurnContext: vi.fn(), unregisterTurnContext: vi.fn() } as unknown as McpHost,
      () => storeA.snapshot, () => false, () => "idle",
      vi.fn(() => true), vi.fn(), vi.fn(),
    );
    try {
      await bridge.choose(storeB.id);
      expect(await bridge.command("/goal Check the build")).toContain("Goal: complete");
      expect((await SessionStore.listAll()).find((item) => item.id === storeB.id)?.goal?.status).toBe("complete");
      expect(storeA.snapshot.goal).toBeUndefined();
    } finally { await bridge.shutdown(); }
  });

  it("attaches files to the chosen project and sends them in the remote browser tab", async () => {
    const { alpha, beta, storeA, storeB } = await setup();
    const filename = path.join(beta, "data.txt");
    await writeFile(filename, "file content");
    let sideEvents!: HarnessEvents;
    const send = vi.fn(async (_message: string, _signal: AbortSignal, options: { files?: Array<{ path: string }>; onSubmitted?: () => void }) => {
      expect(options.files?.[0]?.path).toBe(await realpath(filename));
      options.onSubmitted?.();
      sideEvents.emit({ type: "assistant-done", id: "attachment-answer", text: "File received", channel: "telegram" });
      return "File received";
    });
    const browser = {
      isOpen: true,
      openSideChat: vi.fn(async (events: HarnessEvents) => {
        sideEvents = events;
        return { isOpen: true, send, setResponseChannel: vi.fn(), snapshotBeforeTool: vi.fn(), closeSideChat: vi.fn(), stop: vi.fn() };
      }),
    } as unknown as ChatGptBrowser;
    const mcp = { registerTurnContext: vi.fn(), unregisterTurnContext: vi.fn() } as unknown as McpHost;
    const bridge = new TelegramSessionBridge(
      defaultConfig(alpha), browser, mcp, () => storeA.snapshot,
      () => false, () => "idle", vi.fn(() => true), vi.fn(), vi.fn(),
    );
    try {
      await bridge.choose(storeB.id);
      expect(await bridge.command('/attach "' + filename + '"')).toContain("data.txt");
      expect(await bridge.command("/attachments")).toContain("pending");
      expect(bridge.submit("Read the attachment")).toBe(true);
      await vi.waitFor(() => expect(bridge.busy).toBe(false));
      expect(send).toHaveBeenCalledTimes(1);
      const remote = (await SessionStore.listAll()).find((item) => item.id === storeB.id);
      expect(remote?.attachments?.[0]?.pending).toBe(false);
      expect(storeA.snapshot.attachments).toBeUndefined();
    } finally { await bridge.shutdown(); }
  });

  it("routes the selected foreign session to a background tab without changing the root chat", async () => {
    const { alpha, beta, storeA, storeB } = await setup();
    const config = defaultConfig(alpha);
    config.browser.attachConnector = true;
    let sideEvents: HarnessEvents | undefined;
    let emitted: string[] = [];
    const sideBrowser = {
      send: vi.fn(async (_message: string, _signal: AbortSignal, options: { turnId: string }) => {
        sideEvents!.emit({ type: "assistant-start", id: "assistant-tg", channel: "telegram" });
        sideEvents!.emit({ type: "assistant-delta", id: "assistant-tg", text: "Reply for beta folder", channel: "telegram" });
        sideEvents!.emit({ type: "assistant-done", id: "assistant-tg", text: "Reply for beta folder", channel: "telegram" });
        return "Reply for beta folder";
      }),
      setResponseChannel: vi.fn(),
      closeSideChat: vi.fn(async () => undefined),
      snapshotBeforeTool: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const browser = {
      isOpen: true,
      openSideChat: vi.fn(async (events: HarnessEvents) => { sideEvents = events; return sideBrowser; }),
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

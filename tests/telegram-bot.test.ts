import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBot, type TelegramBotCallbacks } from "../src/telegram/bot.js";
import { HarnessEvents } from "../src/events.js";
import type { TelegramSessionChoice } from "../src/telegram/sessions.js";

type BotInternals = {
  running: boolean;
  lastEditAt: number;
  onMessage(message: { message_id: number; chat: { id: number; type: string }; from: { id: number }; text: string }, updateId: number): Promise<void>;
  flushDashboard(): Promise<void>;
};

const rootSession: TelegramSessionChoice = { id: "11111111-1111-4111-8111-111111111111", title: "Alpha", workspace: "/projects/alpha", updatedAt: 1 };
const betaSession: TelegramSessionChoice = { id: "22222222-2222-4222-8222-222222222222", title: "Beta", workspace: "/projects/beta", updatedAt: 2 };

let originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function setup() {
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  let id = 99;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ method, body });
    const result = method === "sendMessage" ? { message_id: ++id } : true;
    return { ok: true, json: async () => ({ ok: true, result }) } as Response;
  }) as typeof fetch;
  const events = new HarnessEvents();
  let selected = rootSession;
  const callbacks: TelegramBotCallbacks = {
    events, workspace: rootSession.workspace,
    selectedSession: () => selected,
    listSessions: async () => [betaSession, rootSession],
    chooseSession: async (id) => {
      selected = [betaSession, rootSession].find((session) => session.id === id) ?? rootSession;
      return selected;
    },
    createSession: async () => betaSession,
    resetSession: vi.fn(),
    folderList: async () => [rootSession.workspace, betaSession.workspace],
    isRootSelected: () => selected.id === rootSession.id,
    getBusy: () => false,
    getPhase: () => "idle",
    submit: vi.fn(() => true),
    cancel: vi.fn(),
    approve: vi.fn(),
    onStatus: vi.fn(),
    onPaired: vi.fn(async () => undefined),
    saveProfile: vi.fn(),
    onPairExpired: vi.fn(),
  };
  const bot = new TelegramBot("test-token", {
    enabled: true, ownerUserId: "42", ownerChatId: "42", botUsername: "agent_bot", dashboardMessageId: 0, updateOffset: 0,
  }, undefined, callbacks);
  const internals = bot as unknown as BotInternals;
  internals.running = true;
  const message = (n: number, text: string) => ({
    message_id: n, chat: { id: 42, type: "private" }, from: { id: 42 }, text,
  });
  return { events, requests, callbacks, bot, internals, message };
}

describe("Telegram interactive session cards", () => {
  it("creates a new card for every user message rather than editing the previous card", async () => {
    const { internals, requests, message, bot } = setup();
    try {
      await internals.onMessage(message(1, "Build something"), 1);
      await internals.onMessage(message(2, "Another message"), 2);
      const cards = requests.filter((item) => item.method === "sendMessage");
      expect(cards).toHaveLength(2);
      expect(cards[0]?.body.message_id).toBeUndefined();
      expect(cards[1]?.body.message_id).toBeUndefined();
    } finally { await bot.stop(); }
  });

  it("edits one tool row and replaces the old tool with the next", async () => {
    const { internals, requests, message, events, bot } = setup();
    try {
      await internals.onMessage(message(1, "Run checks"), 1);
      events.emit({ type: "turn-start", turnId: "abc" });
      events.emit({ type: "tool-start", call: { id: "t1", name: "read_file", args: {}, status: "running", startedAt: Date.now() } });
      internals.lastEditAt = 0;
      await internals.flushDashboard();
      expect(requests.at(-1)?.method).toBe("editMessageText");
      expect(requests.at(-1)?.body.text).toContain("read_file");
      const cardId = requests.at(-1)?.body.message_id;
      events.emit({ type: "tool-start", call: { id: "t2", name: "exec_command", args: {}, status: "running", startedAt: Date.now() } });
      internals.lastEditAt = 0;
      await internals.flushDashboard();
      expect(requests.at(-1)?.body.message_id).toBe(cardId);
      expect(requests.at(-1)?.body.text).toContain("exec_command");
      expect(requests.at(-1)?.body.text).not.toContain("read_file");
    } finally { await bot.stop(); }
  });

  it("selects a saved chat from an indexed workspace menu", async () => {
    const { internals, requests, message, bot } = setup();
    try {
      await internals.onMessage(message(1, "/sessions"), 1);
      internals.lastEditAt = 0;
      await internals.flushDashboard();
      const last = requests.at(-1)!.body;
      const keyboard = last.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
      expect(keyboard.inline_keyboard.flat().map((button) => button.callback_data)).toContain(`ss:${betaSession.id}`);
      expect(keyboard.inline_keyboard.flat().map((button) => button.callback_data)).toContain(`ss:${rootSession.id}`);
    } finally { await bot.stop(); }
  });
});

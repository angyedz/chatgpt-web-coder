import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramSideQuestions } from "../src/telegram/side-questions.js";
import type { SavedSession } from "../src/runtime/sessions.js";
import type { ChatGptBrowser } from "../src/browser/chatgpt.js";

afterEach(() => vi.restoreAllMocks());

function saved(id: string): SavedSession {
  return {
    version: 1, id, workspace: "/projects/telegram-remote", title: "Remote project",
    createdAt: 1, updatedAt: 1, messages: [], tools: [], plan: [], jobs: [],
    timers: [], contextSummary: "", order: 0,
  };
}

describe("Telegram independent side questions", () => {
  it("uses an isolated no-tool browser tab and returns its real answer", async () => {
    const side = { send: vi.fn(async (_prompt: string, _signal: AbortSignal) => "Answer for the remote project"), closeSideChat: vi.fn(async () => undefined) };
    const root = { isOpen: true, openSideChat: vi.fn(async () => side) } as unknown as ChatGptBrowser;
    const questions = new TelegramSideQuestions(root);
    const answer = await questions.ask(saved("remote-1"), "What does this code do?");
    expect(answer).toBe("Answer for the remote project");
    expect(root.openSideChat).toHaveBeenCalledOnce();
    expect(side.send.mock.calls[0]?.[0]).toContain("/projects/telegram-remote");
    expect(side.send.mock.calls[0]?.[0]).toContain("Do not use tools");
    expect(side.closeSideChat).toHaveBeenCalledOnce();
  });

  it("cancels the side question without touching the root browser", async () => {
    const side = {
      send: vi.fn((_prompt: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })),
      stop: vi.fn(async () => undefined),
      closeSideChat: vi.fn(async () => undefined),
    };
    const root = { isOpen: true, openSideChat: vi.fn(async () => side), stop: vi.fn() } as unknown as ChatGptBrowser;
    const questions = new TelegramSideQuestions(root);
    const task = questions.ask(saved("remote-2"), "Question");
    await vi.waitFor(() => expect(side.send).toHaveBeenCalledOnce());
    expect(questions.cancel("remote-2")).toBe(true);
    await expect(task).rejects.toThrow("aborted");
    expect(side.stop).toHaveBeenCalledOnce();
    expect(side.closeSideChat).toHaveBeenCalledOnce();
    expect(root.stop).not.toHaveBeenCalled();
  });
});

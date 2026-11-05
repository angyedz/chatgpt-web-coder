import { HarnessEvents } from "../events.js";
import { sessionHandoff, type SavedSession } from "../runtime/sessions.js";
import type { ChatGptBrowser } from "../browser/chatgpt.js";

/** A side question uses an independent background ChatGPT tab and no MCP tools. */
export class TelegramSideQuestions {
  private readonly active = new Map<string, { controller: AbortController; browser?: ChatGptBrowser }>();

  constructor(private readonly rootBrowser: ChatGptBrowser) {}

  async ask(session: SavedSession, question: string): Promise<string> {
    if (question.trim().toLowerCase() === "cancel") {
      return this.cancel(session.id) ? "Stopping the side question." : "No side question is running.";
    }
    if (!question.trim()) throw new Error("Usage: /btw <question> or /btw cancel.");
    if (this.active.has(session.id)) throw new Error("A side question is already running for this session.");
    if (!this.rootBrowser.isOpen) throw new Error("ChatGPT browser is not connected.");

    const active: { controller: AbortController; browser?: ChatGptBrowser } = { controller: new AbortController() };
    this.active.set(session.id, active);
    try {
      active.browser = await this.rootBrowser.openSideChat(new HarnessEvents());
      active.controller.signal.throwIfAborted();
      const prompt = [
        "You are answering a private side question independently of an ongoing coding agent.",
        "Do not use tools, interact with the project or take actions. The saved session summary may be incomplete.",
        "Answer only the question, and do not instruct the other agent.",
        "Project workspace: " + session.workspace,
        "SESSION SNAPSHOT:",
        sessionHandoff(session),
        "SIDE QUESTION:",
        question.trim(),
      ].join("\n\n");
      const answer = await active.browser.send(prompt, active.controller.signal);
      active.controller.signal.throwIfAborted();
      return answer || "(ChatGPT returned no text.)";
    } finally {
      await active.browser?.closeSideChat().catch(() => undefined);
      if (this.active.get(session.id) === active) this.active.delete(session.id);
    }
  }

  cancel(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    if (!active) return false;
    active.controller.abort();
    void active.browser?.stop().catch(() => undefined);
    return true;
  }

  async shutdown(): Promise<void> {
    const active = [...this.active.values()];
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map((item) => item.browser?.closeSideChat()));
    this.active.clear();
  }
}

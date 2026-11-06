import { chromium } from "playwright";
import { expect, it } from "vitest";
import { ChatGptBrowser } from "../src/browser/chatgpt.js";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";
import type { HarnessEvent, ToolCallView } from "../src/types.js";

it("does not finish on repeated Thinking placeholders while the send control is disabled and no stop control has mounted", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const config = defaultConfig().browser;
  config.attachConnector = false;
  const events = new HarnessEvents();
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  const controller = new AbortController();
  let response: Promise<unknown> | undefined;
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><div id="messages"><article data-testid="conversation-turn-0"><div data-message-author-role="assistant">Previous answer.</div><button data-testid="copy-turn-action-button">Copy</button></article></div>
      <script>document.querySelector('button').onclick = () => {
        document.querySelector('button').disabled = true;
        document.body.dataset.sent = 'yes';
        setTimeout(() => { document.querySelector('#messages').innerHTML += '<div data-message-author-role="assistant">Thinking<br>Thinking</div>'; }, 3_000);
      };</script>`);
    let settled = false;
    response = adapter.send("Continue the work", controller.signal).catch((error: unknown) => error).finally(() => { settled = true; });
    await page.waitForFunction(() => document.body.dataset.sent === "yes");
    const call: ToolCallView = { id: "early-tool", name: "read_file", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    await page.waitForTimeout(4_000);
    expect(settled).toBe(false);
    await page.evaluate(() => {
      document.querySelectorAll('[data-message-author-role="assistant"]')[1]!.outerHTML = '<article data-testid="conversation-turn-1"><div data-message-author-role="assistant"><div class="markdown">The requested work is complete.</div></div><button data-testid="copy-turn-action-button">Copy</button></article>';
    });
    expect(await response).toBe("The requested work is complete.");
  } finally {
    controller.abort();
    await response;
    await adapter.close();
    await browser.close();
  }
}, 15_000);

it("keeps a slow tool-using response alive beyond the old timeout without stopping or resending it", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const seen: HarnessEvent[] = [];
  events.on((event) => seen.push(event));
  const config = defaultConfig().browser;
  config.attachConnector = false;
  config.responseTimeoutMs = 300;
  // Legacy persisted thresholds must not enable automatic stopping by themselves.
  config.stallRecoveryMs = 100;
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><div id="messages"></div>
      <script>document.querySelector('button').onclick = () => {
        document.body.dataset.sends = String(Number(document.body.dataset.sends || 0) + 1);
        document.querySelector('#messages').innerHTML = '<div data-message-author-role="assistant"><div class="markdown">Inspecting the project.</div></div>';
        const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; stop.id = 'active-stop';
        stop.onclick = () => { document.body.dataset.stopped = 'yes'; };
        document.body.appendChild(stop);
      };</script>`);
    let settled = false;
    const response = adapter.send("Continue working", new AbortController().signal, { canRecoverStall: () => true })
      .catch((error: unknown) => error).finally(() => { settled = true; });
    await page.waitForSelector("#active-stop");
    const call: ToolCallView = { id: "long-response-tool", name: "read_file", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "approval", request: { id: "slow-approval", tool: "read_file", summary: "Continue reading", args: {}, createdAt: Date.now() } });
    await page.waitForTimeout(600);
    expect(settled).toBe(false);
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    await page.waitForTimeout(400);
    expect(settled).toBe(false);
    events.emit({ type: "approval-resolved", id: "slow-approval", allowed: true });
    await page.waitForTimeout(1_200);
    expect(settled).toBe(false);
    expect(await page.locator("body").getAttribute("data-stopped")).toBeNull();
    await page.evaluate(() => {
      document.querySelector(".markdown")!.textContent = "The requested work is finished.";
      document.querySelector("#active-stop")!.remove();
    });
    expect(await response).toContain("The requested work is finished.");
    expect(await page.locator("body").getAttribute("data-sends")).toBe("1");
    expect(seen.some((event) => event.type === "phase" && event.phase === "error")).toBe(false);
    expect(seen.some((event) => event.type === "notice" && event.text.includes("Still waiting for ChatGPT"))).toBe(true);
  } finally {
    await adapter.close();
    await browser.close();
  }
}, 15_000);

it("allows a response to start after the old startup grace period", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const adapter = new ChatGptBrowser(defaultConfig().browser, new HarnessEvents());
  Object.assign(adapter, { context, page });
  const internal = adapter as unknown as { waitForResponseStart(ms: number, signal: AbortSignal, epoch: number): Promise<void> };
  const controller = new AbortController();
  try {
    await page.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
    let settled = false;
    const response = internal.waitForResponseStart(200, controller.signal, 0)
      .catch((error: unknown) => error).finally(() => { settled = true; });
    await page.waitForTimeout(800);
    expect(settled).toBe(false);
    await page.evaluate(() => {
      const stop = document.createElement("button");
      stop.dataset.testid = "stop-button";
      document.body.appendChild(stop);
    });
    expect(await response).toBeUndefined();
    expect(adapter.hasActiveResponse).toBe(false);
  } finally {
    controller.abort();
    await adapter.close();
    await browser.close();
  }
}, 10_000);

it("keeps a delayed response cancellable by the user", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const config = defaultConfig().browser;
  config.attachConnector = false;
  config.responseTimeoutMs = 100;
  const adapter = new ChatGptBrowser(config, new HarnessEvents());
  Object.assign(adapter, { context, page, chatStarted: true });
  const controller = new AbortController();
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button>
      <script>document.querySelector('button').onclick = () => {
        const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; document.body.appendChild(stop);
      };</script>`);
    const response = adapter.send("Think for a while", controller.signal).catch((error: unknown) => error);
    await page.waitForSelector('[data-testid="stop-button"]');
    await page.waitForTimeout(600);
    controller.abort();
    expect(await response).toMatchObject({ name: "AbortError" });
    expect(adapter.hasActiveResponse).toBe(false);
  } finally {
    controller.abort();
    await adapter.close();
    await browser.close();
  }
}, 10_000);

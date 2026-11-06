import { chromium } from "playwright";
import { expect, it } from "vitest";
import { readMarkdown } from "../src/browser/markdown.js";
import { ChatGptBrowser } from "../src/browser/chatgpt.js";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";
import type { HarnessEvent, ToolCallView } from "../src/types.js";

it("converts rendered ChatGPT markup to Markdown with readable structure", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="markdown"><h2>Results</h2><p>First <strong>important</strong> paragraph.</p><ul><li>One</li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol><p><a href="https://example.com">Source</a></p><pre><code class="language-ts">  const x = 1;\n</code></pre></div>`);
    const result = await readMarkdown(page.locator(".markdown"));
    expect(result).toContain("## Results");
    expect(result).toContain("First **important** paragraph.");
    expect(result).toContain("- One\n- Two");
    expect(result).toContain("1. First\n2. Second");
    expect(result).toContain("[Source](https://example.com)");
    expect(result).toContain("```ts\n  const x = 1;\n```");
  } finally {
    await browser.close();
  }
});

it("captures assistant text before, between and after tool calls", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const seen: HarnessEvent[] = [];
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.responseTimeoutMs = 10_000;
  const adapter = new ChatGptBrowser(config, events);
  events.on((event) => seen.push(event));
  Object.assign(adapter, { context, page, chatStarted: true });
  let toolNumber = 0;
  const mockTool = async () => {
    await adapter.snapshotBeforeTool();
    const call: ToolCallView = { id: `tool-${++toolNumber}`, name: "search", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
  };
  try {
    await page.setContent(`
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button><div id="messages"></div>
      <script>
        window.add = text => {
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          message.innerHTML = '<div class="markdown"><p></p></div>';
          message.querySelector('p').textContent = text;
          document.querySelector('#messages').appendChild(message);
        };
        document.querySelector('button').onclick = () => {
          window.add('Before first tool.');
        };
      </script>`);
    const response = adapter.send("search", new AbortController().signal);
    await page.waitForFunction(() => document.querySelector("#messages")?.textContent?.includes("Before first tool."));
    await mockTool();
    await page.evaluate(() => (window as unknown as { add: (text: string) => void }).add("Between the tools."));
    await mockTool();
    await page.evaluate(() => (window as unknown as { add: (text: string) => void }).add("Final answer."));
    const answer = await response;
    expect(answer).toContain("Final answer.");
    const timeline = seen.flatMap((event) => event.type === "assistant-done" ? [event.text] : event.type === "tool-start" ? [event.call.id] : []);
    expect(timeline).toEqual(["Before first tool.", "tool-1", "Between the tools.", "tool-2", "Final answer."]);
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 15_000);

it("ignores the progress label and waits for the visible stop button to disappear", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const seen: HarnessEvent[] = [];
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.responseTimeoutMs = 15_000;
  const adapter = new ChatGptBrowser(config, events);
  events.on((event) => seen.push(event));
  Object.assign(adapter, { context, page, chatStarted: true });
  try {
    await page.setContent(`
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
      <button data-testid="stop-button" style="display:none">Hidden stop</button>
      <div id="messages"></div>
      <script>
        document.querySelector('[data-testid="send-button"]').onclick = () => {
          const stop = document.createElement('button');
          stop.dataset.testid = 'stop-button';
          stop.id = 'active-stop';
          stop.textContent = 'Stop';
          document.body.appendChild(stop);
          document.querySelector('#messages').innerHTML = '<div data-message-author-role="assistant"><div class="markdown">ChatGPT is responding</div></div>';
        };
      </script>`);
    let settled = false;
    const response = adapter.send("build a site", new AbortController().signal).finally(() => { settled = true; });
    await page.waitForSelector("#active-stop");
    await page.waitForTimeout(600);
    expect(seen.filter((event) => event.type === "assistant-delta")).toHaveLength(0);
    await page.locator(".markdown").evaluate((element) => { element.textContent = "I will inspect the project first."; });
    await page.waitForTimeout(3_500);
    expect(settled).toBe(false);
    expect(seen.some((event) => event.type === "assistant-delta" && event.text.includes("inspect the project"))).toBe(true);
    await adapter.snapshotBeforeTool();
    const call: ToolCallView = { id: "tool-1", name: "list_dir", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    await page.locator(".markdown").evaluate((element) => { element.textContent = "The project is ready."; });
    await page.locator("#active-stop").evaluate((element) => element.remove());
    await page.locator('[data-testid="send-button"]').evaluate((element) => { (element as HTMLButtonElement).disabled = true; });
    expect(await response).toBe("The project is ready.");
    expect(seen.some((event) => event.type === "assistant-delta" && event.text.includes("ChatGPT is responding"))).toBe(false);
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 20_000);

it("finishes an idle browser turn after a tool even without new assistant text", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.responseTimeoutMs = 10_000;
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  try {
    await page.setContent(`
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
      <button aria-label="Stop reading aloud">Audio</button>
      <div id="messages"></div>
      <script>
        document.querySelector('[data-testid="send-button"]').onclick = () => {
          document.querySelector('#messages').innerHTML = '<div data-message-author-role="assistant"><div class="markdown">ChatGPT is responding</div></div>';
          const stop = document.createElement('button');
          stop.id = 'active-stop';
          stop.dataset.testid = 'stop-button';
          document.body.appendChild(stop);
        };
      </script>`);
    const response = adapter.send("make a store", new AbortController().signal);
    await page.waitForSelector("#active-stop");
    const call: ToolCallView = { id: "plan-tool", name: "update_plan", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    await page.locator("#active-stop").evaluate((element) => element.remove());
    expect(await response).toBe("");
    expect(adapter.responseEndedAfterTool).toBe(true);
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 15_000);

it("observes a tool-only turn even when the browser has no assistant message node", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.responseTimeoutMs = 10_000;
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button" onclick="document.body.dataset.sent='yes'">Send</button>`);
    const response = adapter.send("make a store", new AbortController().signal);
    await page.waitForFunction(() => document.body.dataset.sent === "yes");
    const call: ToolCallView = { id: "plan-only", name: "update_plan", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    expect(await response).toBe("");
    expect(adapter.responseEndedAfterTool).toBe(true);
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 15_000);

it("recovers a stalled generating response after a tool without waiting for the full timeout", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.stallRecoveryMs = 700;
  config.autoRecoverStalls = true;
  config.responseTimeoutMs = 10_000;
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><div id="messages"></div><script>
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        document.querySelector('#messages').innerHTML = '<div data-message-author-role="assistant"><div class="markdown">Inspecting the project.</div></div>';
        const stop = document.createElement('button'); stop.id = 'active-stop'; stop.dataset.testid = 'stop-button';
        stop.onclick = () => { document.body.dataset.stopped = 'yes'; stop.remove(); };
        document.body.appendChild(stop);
      };
    </script>`);
    const response = adapter.send("build a site", new AbortController().signal, { canRecoverStall: () => true });
    await page.waitForSelector("#active-stop");
    await adapter.snapshotBeforeTool();
    const call: ToolCallView = { id: "tool", name: "update_plan", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    expect(await response).toContain("Inspecting the project.");
    expect(await page.locator("body").getAttribute("data-stopped")).toBe("yes");
    expect(adapter.responseEndedAfterTool).toBe(true);
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 15_000);

it("does not restart while an approval or tool is still pending", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.stallRecoveryMs = 500;
  config.autoRecoverStalls = true;
  config.responseTimeoutMs = 10_000;
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><script>
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        const stop = document.createElement('button'); stop.id = 'active-stop'; stop.dataset.testid = 'stop-button';
        stop.onclick = () => { document.body.dataset.stopped = 'yes'; stop.remove(); };
        document.body.appendChild(stop);
      };
    </script>`);
    const response = adapter.send("build", new AbortController().signal, { canRecoverStall: () => true });
    await page.waitForSelector("#active-stop");
    const call: ToolCallView = { id: "tool", name: "write_file", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "approval", request: { id: "approval", tool: "write_file", summary: "write file", args: {}, createdAt: Date.now() } });
    await page.waitForTimeout(1_200);
    expect(await page.locator("body").getAttribute("data-stopped")).toBeNull();
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    await page.waitForTimeout(1_200);
    expect(await page.locator("body").getAttribute("data-stopped")).toBeNull();
    events.emit({ type: "approval-resolved", id: "approval", allowed: true });
    expect(await response).toBe("");
    expect(await page.locator("body").getAttribute("data-stopped")).toBe("yes");
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 15_000);

it("does not send a continuation when the stop button does not actually stop generation", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.stallRecoveryMs = 500;
  config.autoRecoverStalls = true;
  config.responseTimeoutMs = 10_000;
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  const controller = new AbortController();
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><script>
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        const stop = document.createElement('button'); stop.id = 'active-stop'; stop.dataset.testid = 'stop-button';
        stop.onclick = () => { document.body.dataset.clicked = 'yes'; };
        document.body.appendChild(stop);
      };
    </script>`);
    const response = adapter.send("build", controller.signal, { canRecoverStall: () => true }).catch((error: unknown) => error);
    await page.waitForSelector("#active-stop");
    const call: ToolCallView = { id: "tool", name: "update_plan", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call });
    events.emit({ type: "tool-end", call: { ...call, status: "ok", endedAt: Date.now() } });
    await page.waitForFunction(() => document.body.dataset.clicked === "yes");
    await page.waitForTimeout(700);
    expect(adapter.responseEndedAfterTool).toBe(false);
    controller.abort();
    expect(await response).toMatchObject({ name: "AbortError" });
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 15_000);

it("waits for a late tool call before considering the stopped response safe to resume", async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const page = await context.newPage();
  const events = new HarnessEvents();
  const config = defaultConfig(process.cwd()).browser;
  config.attachConnector = false;
  config.stallRecoveryMs = 500;
  config.autoRecoverStalls = true;
  config.responseTimeoutMs = 15_000;
  const adapter = new ChatGptBrowser(config, events);
  Object.assign(adapter, { context, page, chatStarted: true });
  try {
    await page.setContent(`<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><script>
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        const stop = document.createElement('button'); stop.id = 'active-stop'; stop.dataset.testid = 'stop-button';
        stop.onclick = () => { document.body.dataset.stopped = 'yes'; stop.remove(); };
        document.body.appendChild(stop);
      };
    </script>`);
    let settled = false;
    const response = adapter.send("build", new AbortController().signal, { canRecoverStall: () => true }).finally(() => { settled = true; });
    await page.waitForSelector("#active-stop");
    const first: ToolCallView = { id: "first", name: "update_plan", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call: first });
    events.emit({ type: "tool-end", call: { ...first, status: "ok", endedAt: Date.now() } });
    await page.waitForFunction(() => document.body.dataset.stopped === "yes");
    const late: ToolCallView = { id: "late", name: "write_file", args: {}, status: "running", startedAt: Date.now() };
    events.emit({ type: "tool-start", call: late });
    await page.waitForTimeout(2_400);
    expect(settled).toBe(false);
    events.emit({ type: "tool-end", call: { ...late, status: "ok", endedAt: Date.now() } });
    expect(await response).toBe("");
    expect(adapter.responseEndedAfterTool).toBe(true);
  } finally {
    await adapter.close();
    await chromiumBrowser.close();
  }
}, 20_000);

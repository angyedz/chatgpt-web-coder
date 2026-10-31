import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatGptBrowser } from "../src/browser/chatgpt.js";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";

const PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Mock ChatGPT</title></head>
  <body>
    <h1>Mock ChatGPT</h1>
    <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    <button data-testid="send-button">Send</button>
    <div id="messages"></div>
    <div id="mention-menu" style="display:none">
      <div class="__menu-item" tabindex="0"><span>chatgpt-coder</span></div>
    </div>
    <script>
      const composer = document.querySelector('#prompt-textarea');
      const send = document.querySelector('[data-testid="send-button"]');
      const messages = document.querySelector('#messages');
      const menu = document.querySelector('#mention-menu');
      const connectorRow = menu.querySelector('.__menu-item');

      composer.addEventListener('input', () => {
        const text = composer.textContent || '';
        if (text.startsWith('@')) {
          menu.style.display = 'block';
          connectorRow.setAttribute('data-highlighted', '');
        } else {
          menu.style.display = 'none';
        }
      });

      composer.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || menu.style.display === 'none') return;
        event.preventDefault();
        composer.innerHTML = '<span data-id="plugin:chatgpt-coder" data-keyword="chatgpt-coder" contenteditable="false">chatgpt-coder</span>';
        menu.style.display = 'none';
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });

      send.addEventListener('click', () => {
        const prompt = composer.innerText || '';
        composer.innerText = '';
        const message = document.createElement('div');
        message.setAttribute('data-message-author-role', 'assistant');
        const markdown = document.createElement('div');
        markdown.className = 'markdown';
        message.appendChild(markdown);
        messages.appendChild(message);

        const stop = document.createElement('button');
        stop.setAttribute('data-testid', 'stop-button');
        stop.textContent = 'Stop';
        document.body.appendChild(stop);

        const full = 'Mock answer: ' + prompt;
        let index = 0;
        const timer = setInterval(() => {
          index += 1;
          markdown.innerText = full.slice(0, index);
          if (index >= full.length) {
            clearInterval(timer);
            stop.remove();
          }
        }, 8);
      });
    </script>
  </body>
</html>`;

describe("ChatGptBrowser adapter", () => {
  let server: Server;
  let baseUrl: string;
  let userDataDir: string;
  let browser: ChatGptBrowser | undefined;

  beforeEach(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), "cc-browser-"));
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server port");
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(userDataDir, { recursive: true, force: true });
  });

  it(
    "sends a prompt and streams the assistant answer",
    async () => {
      const config = defaultConfig(userDataDir);
      config.browser.headless = true;
      config.browser.baseUrl = baseUrl;
      config.browser.userDataDir = userDataDir;
      config.browser.loginTimeoutMs = 10_000;
      config.browser.responseTimeoutMs = 20_000;
      config.browser.navigationTimeoutMs = 10_000;
      config.browser.attachConnector = false;

      browser = new ChatGptBrowser(config.browser, new HarnessEvents());
      await browser.connect();
      await browser.ensureLoggedIn();

      const answer = await browser.send("ping", new AbortController().signal);
      expect(answer).toContain("Mock answer: ping");
    },
    45_000,
  );

  it(
    "attaches the MCP connector through the @ mention menu before sending",
    async () => {
      const config = defaultConfig(userDataDir);
      config.browser.headless = true;
      config.browser.baseUrl = baseUrl;
      config.browser.userDataDir = userDataDir;
      config.browser.loginTimeoutMs = 10_000;
      config.browser.responseTimeoutMs = 20_000;
      config.browser.navigationTimeoutMs = 10_000;
      config.browser.attachConnector = true;
      config.browser.connectorName = "chatgpt-coder";

      const events = new HarnessEvents();
      const notices: string[] = [];
      events.on((event) => {
        if (event.type === "notice") notices.push(event.text);
      });

      browser = new ChatGptBrowser(config.browser, events);
      await browser.connect();
      await browser.ensureLoggedIn();

      const answer = await browser.send(
        "do the thing",
        new AbortController().signal,
      );
      expect(answer).toContain("do the thing");
      expect(answer).toContain("chatgpt-coder");
      expect(notices).toContain("Attached connector: chatgpt-coder");
    },
    45_000,
  );
});

import { chromium } from "playwright";
import { expect, it } from "vitest";
import { ChatGptBrowser } from "../src/browser/chatgpt.js";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";

it("personalizes a temporary background chat and selects an unhighlighted MCP option without typing in the primary page", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const primary = await context.newPage();
  const config = defaultConfig().browser;
  config.attachConnector = true;
  const adapter = new ChatGptBrowser(config, new HarnessEvents());
  Object.assign(adapter, { context, page, chatStarted: true });
  const internal = adapter as unknown as { ensureTemporaryPersonalization(): Promise<void> };
  try {
    await primary.setContent('<div contenteditable="true">Keep primary draft</div>');
    await primary.locator('[contenteditable]').focus();
    await page.setContent(`<button id="mode">Unpersonalized</button>
      <div id="modes" role="menu" hidden><button role="menuitem">Personalized</button></div>
      <div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button>
      <div id="apps" role="listbox" hidden><button role="option"><span>chatgpt-coder</span></button></div><div id="messages"></div>
      <script>
        const editor = document.querySelector('#prompt-textarea');
        document.querySelector('#mode').onclick = () => { document.querySelector('#modes').hidden = false; };
        document.querySelector('[role="menuitem"]').onclick = () => { document.querySelector('#mode').textContent = 'Personalized'; document.querySelector('#modes').hidden = true; };
        editor.oninput = () => { document.querySelector('#apps').hidden = !(editor.textContent.startsWith('@') && document.querySelector('#mode').textContent === 'Personalized'); };
        document.querySelector('[role="option"]').onclick = () => {
          editor.innerHTML = '<span app-mention-path="app://test" app-mention-display-name="chatgpt-coder" contenteditable="false">chatgpt-coder</span>';
          document.querySelector('#apps').hidden = true;
          const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        };
        document.querySelector('[data-testid="send-button"]').onclick = () => {
          document.body.dataset.sent = editor.innerText;
          document.querySelector('#messages').innerHTML = '<div data-message-author-role="assistant"><div class="markdown">MCP connector attached.</div></div>';
        };
      </script>`);
    await internal.ensureTemporaryPersonalization();
    expect(await page.locator('#mode').innerText()).toBe("Personalized");
    expect(await adapter.send("Inspect project", new AbortController().signal, { continueChat: true })).toBe("MCP connector attached.");
    expect(await page.locator('body').getAttribute('data-sent')).toContain("chatgpt-coder");
    expect(await page.locator('body').getAttribute('data-sent')).toContain("Inspect project");
    expect(await primary.locator('[contenteditable]').innerText()).toBe("Keep primary draft");
  } finally {
    await adapter.close();
    await browser.close();
  }
}, 15_000);

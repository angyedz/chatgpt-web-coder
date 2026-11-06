import type { BrowserContext, Locator, Page } from "playwright";
import type { BrowserConfig } from "../config.js";
import type { HarnessEvents } from "../events.js";
import { selectors, type SelectorGroup } from "./selectors.js";
import { ResponseStream } from "./response-stream.js";
import { cleanBrowserFallback, extractResponse, removeObservedActivity, removeResponseStatus } from "./response-text.js";
import { readFallbackText, readMarkdown } from "./markdown.js";
import { newId } from "../utils/ids.js";
import { setTimeout as delay } from "node:timers/promises";
import { preparePicker, readPicker, type PickerKind } from "./picker.js";
import { withBrowserUi } from "./ui-queue.js";

/** Connector preparation failed before the message was submitted; safe to retry. */
export class ConnectorAttachmentError extends Error {}

export class ChatGptBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private baseline = 0;
  private baselineMarkdown = 0;
  private submittedPrompt = "";
  private chatStarted = false;
  private closing = false;
  private connecting?: Promise<void>;
  private readonly activeToolCalls = new Set<string>();
  private toolEpoch = 0;
  private responseStream?: ResponseStream;
  private responseChannel?: "telegram";
  private responseSignal?: AbortSignal;
  private readSequence = 0;
  private appliedReadSequence = 0;
  private preparingToolCalls = 0;
  private endedAfterTool = false;
  private sawStopButton = false;
  private readonly pendingApprovals = new Set<string>();
  private interactiveControls = new Map<string, Locator>();
  private interactiveAnchor?: Locator;
  private lastInteraction = 0;
  private lastProgressAt?: number;
  private readonly appliedPicker: Partial<Record<PickerKind, string>> = {};

  constructor(
    private readonly config: BrowserConfig,
    private readonly events: HarnessEvents,
  ) {
    // Tool calls execute locally, but their lifecycle arrives on the same event
    // bus. Never treat an answer as final while a tool is still running, and
    // restart the quiet-period timer after every tool result.
    this.events.on((event) => {
      if (event.type === "tool-start") {
        if (this.activeToolCalls.has(event.call.id)) return;
        this.responseStream?.toolStarted();
        this.activeToolCalls.add(event.call.id);
        this.toolEpoch += 1;
      } else if (event.type === "tool-end") {
        if (this.activeToolCalls.delete(event.call.id)) this.toolEpoch += 1;
      } else if (event.type === "approval") {
        this.pendingApprovals.add(event.request.id);
      } else if (event.type === "approval-resolved") {
        this.pendingApprovals.delete(event.id);
      }
    });
  }

  get isOpen(): boolean {
    return Boolean(this.context && this.page && !this.page.isClosed());
  }

  get hasActiveResponse(): boolean {
    return Boolean(this.responseStream);
  }

  get currentPage(): Page | undefined {
    return this.page;
  }

  /** Bring this chat tab to the foreground only after an explicit user request. */
  async bringToFront(): Promise<void> {
    await this.requirePage().bringToFront();
  }

  async openSideChat(events: HarnessEvents, options: { attachConnector?: boolean } = {}): Promise<ChatGptBrowser> {
    if (!this.isOpen || !this.context) throw new Error("The main ChatGPT browser is not connected.");
    return withBrowserUi(this.context, () => this.openSideChatUnlocked(events, options));
  }

  private async openSideChatUnlocked(events: HarnessEvents, options: { attachConnector?: boolean }): Promise<ChatGptBrowser> {
    const context = this.context;
    if (!this.isOpen || !context) throw new Error("The main ChatGPT browser is not connected.");
    const side = new ChatGptBrowser({
      ...this.config,
      attachConnector: options.attachConnector ?? false,
      newChatPerTurn: true,
      useTemporaryChat: this.config.useTemporaryChat,
    }, events);
    side.context = context;
    // Playwright's headless shell does not support CDP's background option;
    // a headless page cannot steal OS focus because no window exists.
    if (this.config.headless) {
      side.page = await context.newPage();
    } else {
      // Never call newPage() in headed mode: it can steal the user's focus.
      // Fail closed if the background target API is unavailable.
      const browser = context.browser();
      if (!browser) throw new Error("Background tabs require Chromium's browser CDP connection.");
      const cdp = await browser.newBrowserCDPSession();
      const url = `about:blank#chatgpt-coder-side-${newId("tab")}`;
      try {
        const created = await cdp.send("Target.createTarget", { url, background: true, focus: false });
        // The initial 'page' event can precede its first URL update; poll for
        // our unique marker rather than missing the event or using another
        // worker's simultaneously created tab.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          side.page = context.pages().find((page) => !page.isClosed() && page.url() === url);
          if (side.page) break;
          await delay(100);
        }
        if (!side.page) {
          await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
          throw new Error("The background tab was not discovered; no foreground fallback was used.");
        }
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }
    try {
      await side.preparePage();
      return side;
    } catch (error) {
      await side.page?.close().catch(() => undefined);
      throw error;
    }
  }

  async closeSideChat(): Promise<void> {
    this.closing = true;
    await this.page?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
  }

  get responseEndedAfterTool(): boolean {
    return this.endedAfterTool;
  }

  get interactionRevision(): number {
    return this.lastInteraction;
  }

  async connect(): Promise<void> {
    if (this.isOpen) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.events.emit({
      type: "status",
      key: "browser",
      state: "starting",
      detail: "launching Chromium",
    });

    if (this.context) {
      try {
        this.page = await this.context.newPage();
        await this.preparePage();
        this.events.emit({ type: "notice", level: "info", text: "Reopened the browser page. A new message will start a fresh chat; the previous request was not resent." });
        return;
      } catch {
        await this.context?.close().catch(() => undefined);
        this.context = undefined;
        this.page = undefined;
      }
    }
    const { chromium } = await import("playwright");
    const launchOptions = {
      headless: this.config.headless,
      viewport: { width: 1440, height: 920 },
      args: ["--disable-blink-features=AutomationControlled"],
      locale: "en-US",
    };

    try {
      this.context = await chromium.launchPersistentContext(
        this.config.userDataDir,
        this.config.channel
          ? { ...launchOptions, channel: this.config.channel }
          : launchOptions,
      );
    } catch (error) {
      if (this.config.channel) {
        this.events.emit({
          type: "notice",
          level: "warn",
          text: `Could not launch channel "${this.config.channel}", falling back to bundled Chromium.`,
        });
        this.context = await chromium.launchPersistentContext(
          this.config.userDataDir,
          launchOptions,
        );
      } else {
        throw error;
      }
    }

    const context = this.context;
    context.on("close", () => {
      if (this.context === context) {
        this.context = undefined;
        this.page = undefined;
        this.chatStarted = false;
      }
      if (this.closing) return;
      this.events.emit({
        type: "status",
        key: "browser",
        state: "off",
        detail: "browser closed",
      });
    });

    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    try {
      await this.preparePage();
    } catch (error) {
      await context.close().catch(() => undefined);
      if (this.context === context) { this.context = undefined; this.page = undefined; }
      throw error;
    }
  }

  private async preparePage(): Promise<void> {
    const page = this.requirePage();
    this.chatStarted = false;
    this.lastProgressAt = undefined;
    page.on("close", () => {
      if (this.page !== page) return;
      this.page = undefined;
      this.chatStarted = false;
      if (!this.closing) this.events.emit({ type: "status", key: "browser", state: "off", detail: "browser page closed" });
    });
    page.setDefaultTimeout(this.config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    await page.goto(this.config.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.navigationTimeoutMs,
    });

    this.events.emit({
      type: "status",
      key: "browser",
      state: "up",
      detail: "chatgpt.com",
    });
  }

  async ensureLoggedIn(): Promise<void> {
    if (!this.isOpen) await this.connect();
    const page = this.requirePage();

    if (await this.waitForAny("composer", 8_000)) {
      return;
    }

    this.events.emit({ type: "phase", phase: "waiting-login" });
    this.events.emit({
      type: "notice",
      level: "warn",
      text: "Sign in to ChatGPT in the opened browser window. Waiting for the composer...",
    });

    const deadline = Date.now() + this.config.loginTimeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("Browser page was closed during login.");
      if (await this.waitForAny("composer", 2_000)) {
        this.events.emit({ type: "phase", phase: "idle" });
        this.events.emit({
          type: "status",
          key: "browser",
          state: "up",
          detail: "signed in",
        });
        return;
      }
      const login = await this.firstVisible("loginButton");
      if (login) {
        this.events.emit({
          type: "notice",
          level: "info",
          text: "Login page detected. Complete the sign-in flow in the browser.",
        });
      }
    }

    throw new Error("Timed out waiting for ChatGPT login.");
  }

  async newChat(): Promise<void> {
    await this.ensureLoggedIn();
    await withBrowserUi(this.context!, () => this.newChatUnlocked());
  }

  private async newChatUnlocked(): Promise<void> {
    const page = this.requirePage();
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const url = this.config.useTemporaryChat
      ? `${base}/?temporary-chat=true`
      : `${base}/`;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.config.navigationTimeoutMs,
    });
    delete this.appliedPicker.model;
    delete this.appliedPicker.effort;
    await this.ensureLoggedIn();
    await this.ensureTemporaryPersonalization();
    this.chatStarted = true;
    this.emitSession();
  }

  async ensureChat(): Promise<void> {
    if (!this.chatStarted || this.config.newChatPerTurn) {
      await this.newChat();
    }
  }

  resetChat(): void {
    this.chatStarted = false;
    this.submittedPrompt = "";
    this.lastProgressAt = undefined;
    delete this.appliedPicker.model;
    delete this.appliedPicker.effort;
  }

  async picker(kind: PickerKind, select?: string): Promise<{ choices: string[]; selected?: string; confirmed?: boolean }> {
    await this.ensureLoggedIn();
    const result = await readPicker(this.requirePage(), kind, select);
    if (result.selected) {
      this.appliedPicker[kind] = result.selected;
      if (kind === "model") delete this.appliedPicker.effort;
    }
    return result;
  }

  private async applyPicker(kind: PickerKind, label: string, signal: AbortSignal): Promise<void> {
    const result = await preparePicker(this.requirePage(), kind, label, signal);
    if (result.selected) {
      this.appliedPicker[kind] = result.selected;
      if (kind === "model") delete this.appliedPicker.effort;
    }
  }

  /** Apply per-session picker overrides without changing the main harness configuration. */
  setPickerPreference(kind: PickerKind, label: string): void {
    if (kind === "model") this.config.modelLabel = label;
    else this.config.effortLabel = label;
    if (!label) delete this.appliedPicker[kind];
    this.refreshSession();
  }

  refreshSession(): void { this.emitSession(); }

  setResponseChannel(channel?: "telegram"): void { this.responseChannel = channel; }

  async send(prompt: string, signal: AbortSignal, options: { continueChat?: boolean; canRecoverStall?: () => boolean; files?: { id: string; name: string; path: string }[]; onSubmitted?: () => void; turnId?: string } = {}): Promise<string> {
    signal.throwIfAborted();
    const outgoingPrompt = options.turnId ? `${prompt}\n\nCurrent harness turn_id (required for tool calls): ${options.turnId}` : prompt;
    await this.ensureLoggedIn();
    const { page, responseStream, initialToolEpoch } = await withBrowserUi(this.context!, async () => {
      signal.throwIfAborted();
      if (!options.continueChat && (!this.chatStarted || this.config.newChatPerTurn)) await this.newChatUnlocked();
      const page = this.requirePage();
      signal.throwIfAborted();
      if (await this.firstVisible("stopButton")) throw new Error("ChatGPT is still generating a previous response. Wait or stop it in the browser before sending another request.");
      if (this.config.modelLabel.trim() && this.appliedPicker.model !== this.config.modelLabel) await this.applyPicker("model", this.config.modelLabel, signal);
      if (this.config.effortLabel.trim() && this.appliedPicker.effort !== this.config.effortLabel) await this.applyPicker("effort", this.config.effortLabel, signal);
      signal.throwIfAborted();
      this.endedAfterTool = false;
      this.sawStopButton = false;
      this.submittedPrompt = outgoingPrompt;
      this.baseline = await this.count("assistantMessage");
      this.baselineMarkdown = await page.locator(selectors.markdown.join(", ")).count();
      await this.fillComposer(outgoingPrompt, options.files ?? [], signal);
      signal.throwIfAborted();
      const responseStream = new ResponseStream(this.events, newId("assistant"), this.responseChannel);
      this.responseStream = responseStream;
      this.responseSignal = signal;
      const initialToolEpoch = this.toolEpoch;
      try {
        await this.clickSend();
        options.onSubmitted?.();
        signal.throwIfAborted();
      } catch (error) {
        responseStream.interrupt(signal.aborted ? "cancelled" : "interrupted");
        this.responseStream = undefined;
        this.responseSignal = undefined;
        throw error;
      }
      return { page, responseStream, initialToolEpoch };
    }, signal);
    try {
    this.events.emit({ type: "phase", phase: "thinking" });
    let lastText = "";
    let stableTicks = 0;
    let idleTicks = 0;
    let started = false;
    let observedToolEpoch = initialToolEpoch;
    let lastProgressAt = Date.now();
    this.lastProgressAt = lastProgressAt;
    let lastApprovalCheck = 0;
    let browserApproval = false;
    let reportedPhase: "thinking" | "responding" | "waiting-approval" | undefined;
    let warnedAboutDelay = false;
    let lastWaitingNoticeAt = Date.now();
    let recoveryAttempted = false;
    await this.waitForResponseStart(120_000, signal, initialToolEpoch);

    // A response may legitimately take hours. Keep observing the same request
    // until it finishes, the user cancels, or the browser actually fails.
    while (true) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (page.isClosed()) throw new Error("Browser page was closed during the turn.");

      if (this.config.autoApproveToolCalls) {
        await this.autoApproveToolCall();
      }

      if (this.toolEpoch !== observedToolEpoch) {
        observedToolEpoch = this.toolEpoch;
        stableTicks = 0;
        idleTicks = 0;
        lastProgressAt = Date.now();
        this.lastProgressAt = lastProgressAt;
        warnedAboutDelay = false;
      }

      const read = ++this.readSequence;
      const epoch = this.toolEpoch;
      const text = await this.lastAssistantText();
      if (!this.acceptRead(responseStream, signal, read, epoch)) {
        signal.throwIfAborted();
        await page.waitForTimeout(250);
        continue;
      }
      if (text && text !== lastText) {
        lastText = text;
        stableTicks = 0;
        idleTicks = 0;
        lastProgressAt = Date.now();
        this.lastProgressAt = lastProgressAt;
        warnedAboutDelay = false;
        started = true;
      } else if (text) {
        stableTicks += 1;
      }
      if (text) responseStream.update(text);

      const streaming = await this.isStreaming();
      signal.throwIfAborted();
      // A tool may start and finish while the browser state is being read.
      // Re-evaluate the quiet period instead of finalizing an older snapshot.
      if (epoch !== this.toolEpoch) continue;
      const toolsQuiet = this.activeToolCalls.size === 0 && this.preparingToolCalls === 0;
      if (Date.now() - lastApprovalCheck >= 2_000) {
        lastApprovalCheck = Date.now();
        const approval = await this.hasBrowserApproval();
        if (approval && !browserApproval) this.events.emit({ type: "notice", level: "warn", text: "ChatGPT is waiting for approval in the browser. Check the browser window." });
        if (approval !== browserApproval) { lastProgressAt = Date.now(); this.lastProgressAt = lastProgressAt; }
        browserApproval = approval;
      }
      if (this.pendingApprovals.size === 0 && toolsQuiet) {
        const phase = browserApproval ? "waiting-approval" : streaming && Date.now() - lastProgressAt < 1_500 && Boolean(lastText) ? "responding" : "thinking";
        if (reportedPhase !== phase) { this.events.emit({ type: "phase", phase }); reportedPhase = phase; }
      } else {
        reportedPhase = undefined;
      }
      signal.throwIfAborted();
      if (epoch !== this.toolEpoch) continue;
      if (!streaming && toolsQuiet) idleTicks += 1;
      else idleTicks = 0;
      const sawTool = this.toolEpoch !== initialToolEpoch;
      const responseIsStable = lastText ? stableTicks >= 8 : sawTool && idleTicks >= 8;
      // A pause in text can mean the model is thinking or preparing its next
      // tool call. A visible stop button is stronger evidence than quiet text.
      if ((started || sawTool) && toolsQuiet && this.pendingApprovals.size === 0 && !browserApproval && responseIsStable && idleTicks >= 8 && !streaming) {
        if (await this.hasBrowserApproval()) { browserApproval = true; idleTicks = 0; continue; }
        signal.throwIfAborted();
        if (epoch !== this.toolEpoch || this.activeToolCalls.size || this.preparingToolCalls || this.pendingApprovals.size) continue;
        const finalText = (lastText || responseStream.lastObservedText).trim();
        if (finalText || sawTool) {
          this.endedAfterTool = sawTool && !responseStream.hasCurrentSegment;
          responseStream.finish();
          return finalText;
        }
      }

      if (streaming && toolsQuiet && !browserApproval && this.pendingApprovals.size === 0 && !warnedAboutDelay && Date.now() - lastProgressAt >= 30_000) {
        warnedAboutDelay = true;
        this.events.emit({ type: "notice", level: "warn", text: "ChatGPT is still generating, but no new text or tool calls have appeared for 30 seconds." });
      }

      const reminderMs = this.config.responseTimeoutMs;
      if (toolsQuiet && !browserApproval && this.pendingApprovals.size === 0 && reminderMs > 0 && Number.isFinite(reminderMs)
        && Date.now() - lastProgressAt >= reminderMs && Date.now() - lastWaitingNoticeAt >= reminderMs) {
        lastWaitingNoticeAt = Date.now();
        this.events.emit({ type: "notice", level: "info", text: "Still waiting for ChatGPT. The response remains active; no request was resent. Use Esc or /stop to cancel." });
      }

      const recoveryMs = this.config.stallRecoveryMs;
      if (this.config.autoRecoverStalls && streaming && sawTool && toolsQuiet && !browserApproval && !recoveryAttempted && recoveryMs > 0 && Number.isFinite(recoveryMs) && Date.now() - lastProgressAt >= recoveryMs && options.canRecoverStall?.() && this.pendingApprovals.size === 0) {
        if (!(await this.hasBrowserApproval())) {
          recoveryAttempted = true;
          this.events.emit({ type: "notice", level: "warn", text: "ChatGPT stopped making progress after a tool call. Attempting to stop the stalled response and continue the unfinished plan…" });
          const stopped = await this.stopStalledResponse(signal, options.canRecoverStall);
          if (stopped) {
            this.endedAfterTool = true;
            responseStream.interrupt("stalled");
            return (lastText || responseStream.lastObservedText).trim();
          }
          this.events.emit({ type: "notice", level: "warn", text: "Could not confirm that ChatGPT stopped; no continuation was sent. Wait or press Esc to cancel." });
        }
      }

      await page.waitForTimeout(250);
    }

    } catch (error) {
      responseStream.interrupt(signal.aborted ? "cancelled" : "interrupted");
      throw error;
    } finally {
      if (this.responseStream === responseStream) {
        this.responseStream = undefined;
        this.responseSignal = undefined;
      }
    }
  }

  async stop(options: { waitForResponse?: boolean; waitMs?: number } = {}): Promise<void> {
    const wasActive = Boolean(this.responseStream) || options.waitForResponse === true;
    try {
      const stop = await this.firstVisible("stopButton") ?? (options.waitForResponse ? await this.waitForAny("stopButton", options.waitMs ?? 5_000) : undefined);
      if (!stop) {
        if (wasActive) this.events.emit({ type: "notice", level: "warn", text: "Could not confirm that ChatGPT stopped. Check the browser before retrying; local cancellation does not undo completed actions." });
        return;
      }
      await stop.click({ timeout: 3_000 });
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (!this.isOpen || !(await this.firstVisible("stopButton"))) return;
        await this.requirePage().waitForTimeout(250);
      }
      this.events.emit({ type: "notice", level: "warn", text: "ChatGPT still appears to be generating. Check the browser before retrying." });
    } catch {
      if (wasActive) this.events.emit({ type: "notice", level: "warn", text: "Could not confirm that ChatGPT stopped. Check the browser before retrying." });
    }
  }

  async snapshotBeforeTool(): Promise<void> {
    const stream = this.responseStream;
    const signal = this.responseSignal;
    if (!stream || !signal || signal.aborted || !this.isOpen) return;
    this.preparingToolCalls += 1;
    try {
      const read = ++this.readSequence;
      const epoch = this.toolEpoch;
      const text = await Promise.race([
        this.lastAssistantText().catch(() => ""),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 500)),
      ]);
      if (text && this.acceptRead(stream, signal, read, epoch)) stream.update(text);
    } finally {
      this.preparingToolCalls -= 1;
    }
  }

  private acceptRead(stream: ResponseStream, signal: AbortSignal, read: number, epoch: number): boolean {
    if (this.responseStream !== stream || signal.aborted || epoch !== this.toolEpoch || read <= this.appliedReadSequence) return false;
    this.appliedReadSequence = read;
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
    this.events.emit({ type: "status", key: "browser", state: "off" });
  }

  private async fillComposer(prompt: string, files: { id: string; name: string; path: string }[], signal: AbortSignal): Promise<void> {
    const page = this.requirePage();
    let composer = await this.activeComposer(30_000);

    const preselected =
      this.config.attachConnector && (await this.connectorSelected(composer));
    const existingText = (await composer.innerText().catch(() => "")).trim();

    if (!preselected || existingText.length > 0) {
      await this.resetComposer(composer);
      if (this.config.attachConnector) {
        composer = await this.attachConnector(composer);
      }
    } else {
      await composer.focus();
    }

    const attached = await this.insertPromptText(composer, prompt);
    if (!attached) {
      throw new Error(
        "Failed to type the prompt into the ChatGPT composer; the editor did not preserve the text.",
      );
    }

    if (files.length) {
      this.events.emit({ type: "phase", phase: "uploading" });
      const form = composer.locator("xpath=ancestor::form[1]");
      const existing = form.locator('.composer-attachment-surface:is(button, [role="button"])');
      for (let index = 0; index < await existing.count(); index += 1) {
        if (await existing.nth(index).isVisible().catch(() => false)) throw new Error("The ChatGPT composer already contains an attachment. Remove it in the browser before retrying; nothing was sent.");
      }
      let input = form.locator('input[data-testid="upload-photos-input"], input[type="file"][multiple]:not([accept])').first();
      if (!(await input.count())) {
        const add = form.locator('button[data-testid*="attach" i], button[aria-label*="attach" i], button[aria-label*="add files" i], button[aria-label*="прикреп" i]').first();
        if (await add.count()) await add.click();
        input = page.locator('input[data-testid="upload-photos-input"], input[type="file"][multiple]:not([accept])').first();
      }
      if (!(await input.count())) throw new Error("The ChatGPT file upload control was not found. The message and attachments were not sent.");
      let uploadFailure = "";
      const observe = (response: import("playwright").Response) => {
        try {
          const url = new URL(response.url());
          if (url.origin === new URL(page.url()).origin && /^\/backend-api\/files(?:\/|$)/.test(url.pathname) && response.status() >= 400) uploadFailure = `upload HTTP ${response.status()}`;
        } catch { /* Ignore unrelated URLs. */ }
      };
      page.on("response", observe);
      try {
        signal.throwIfAborted();
        await input.setInputFiles(files.map((item) => item.path), { timeout: 20_000 });
        const deadline = Date.now() + 60_000;
        let readySince = 0;
        let ready = false;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          if (uploadFailure) throw new Error(`ChatGPT file upload failed (${uploadFailure}). The message was not sent; check the browser before retrying.`);
          const visible = await Promise.all(files.map(async (file) => {
            const cards = form.getByRole("group", { name: file.name, exact: true }).or(form.locator(`.composer-attachment-surface:is(button, [role="button"])[aria-label=${JSON.stringify(file.name)}]`));
            for (let index = 0; index < await cards.count(); index += 1) {
              const card = cards.nth(index);
              if (await card.isVisible().catch(() => false) && await card.locator('[aria-busy="true"], [data-state="loading"], .animate-spin').count().catch(() => 0) === 0) return true;
            }
            return false;
          }));
          if (visible.every(Boolean) && await this.waitForSendEnabled(500)) {
            if (!readySince) readySince = Date.now();
            if (Date.now() - readySince >= 1000) { ready = true; break; }
          } else readySince = 0;
          await page.waitForTimeout(200);
        }
        if (!ready) {
          const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).map((item) => item.trim()).filter(Boolean).slice(0, 3).join(" · ");
          throw new Error(`ChatGPT did not confirm all file attachments${alerts ? `: ${alerts}` : ""}. The message was not sent; check the browser before retrying.`);
        }
      } finally { page.off("response", observe); }
      if (this.config.attachConnector && !(await this.connectorSelected(composer))) throw new Error("The connector disappeared while attaching files. The message was not sent; check the browser.");
      this.events.emit({ type: "phase", phase: "sending" });
    }

    // ProseMirror/Lexical sometimes ignores synthetic input, which leaves the
    // send button disabled. For a browser-only chat we can safely retry via the
    // keyboard; with a connector selected a reset would delete its pill.
    if (!(await this.waitForSendEnabled(3000))) {
      if (!this.config.attachConnector) {
        await this.resetComposer(composer);
        await composer.focus();
        await page.keyboard.insertText(prompt);
      }
      if (!(await this.waitForSendEnabled(3000))) {
        throw new Error(
          "ChatGPT's send button stayed disabled after the prompt was attached.",
        );
      }
    }
  }

  private async activeComposer(timeoutMs: number): Promise<Locator> {
    const composer = await this.waitForAny("composer", timeoutMs);
    if (!composer) throw new Error("ChatGPT composer was not found.");
    return composer;
  }

  private async resetComposer(composer: Locator): Promise<void> {
    const page = this.requirePage();
    await composer.press("Control+A");
    await composer.press("Backspace");
    await page.waitForTimeout(120);
  }

  private async insertPromptText(
    composer: Locator,
    prompt: string,
  ): Promise<boolean> {
    const page = this.requirePage();

    if (!this.config.attachConnector) {
      try {
        await composer.fill(prompt);
      } catch {
        /* fall through to keyboard input */
      }
    }

    let text = await composer.innerText().catch(() => "");
    if (!this.promptAttached(text, prompt)) {
      if (this.config.attachConnector) {
        await composer.focus();
      } else {
        await this.resetComposer(composer);
        await composer.focus();
      }
      await page.keyboard.insertText(prompt);
      text = await composer.innerText().catch(() => "");
    }

    return this.promptAttached(text, prompt);
  }

  private promptAttached(text: string, prompt: string): boolean {
    const normalize = (value: string) =>
      value
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const haystack = normalize(text);
    const needle = normalize(prompt);
    if (!needle) return false;
    if (haystack.length < needle.length * 0.7) return false;
    const tail = needle.slice(-160);
    return haystack.includes(tail);
  }

  private connectorPill(composer: Locator): Locator {
    const name = JSON.stringify(this.config.connectorName.trim());
    return composer.locator(
      [
        `[data-id^="plugin:"][data-keyword=${name}]`,
        `[app-mention-path^="app://"][app-mention-display-name=${name}][contenteditable="false"]`,
      ].join(", "),
    );
  }

  private async connectorSelected(composer: Locator): Promise<boolean> {
    if (!this.config.connectorName.trim()) return false;
    const pills = this.connectorPill(composer);
    const count = await pills.count();
    for (let index = 0; index < count; index += 1) {
      if (await pills.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async attachConnector(composer: Locator): Promise<Locator> {
    const name = this.config.connectorName.trim();
    if (!name) return composer;
    if (await this.connectorSelected(composer)) return composer;

    const page = this.requirePage();
    const rows = page.locator(selectors.connectorMenuRow.join(", "));
    const exact = rows.filter({
      has: page.getByText(name, { exact: true }),
    });
    const firstWord = name.split(/\s+/)[0] ?? name;
    const queries = [...new Set([`@${firstWord}`, `@${name.replace(/\s+/g, "")}`])]
      .filter((query) => query.length > 1);

    let opened = false;
    for (const query of queries) {
      for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
        const active = await this.activeComposer(30_000);
        await this.resetComposer(active);
        await active.focus();
        await active.pressSequentially(query, { delay: 30 });
        try {
          await exact.first().waitFor({ state: "visible", timeout: 2_500 });
          opened = true;
        } catch {
          await active.press("Escape").catch(() => undefined);
          await this.ensureTemporaryPersonalization();
          await page.waitForTimeout(200);
        }
      }
      if (opened) break;
    }

    if (!opened) {
      const active = await this.firstVisible("composer");
      if (active) await this.resetComposer(active).catch(() => undefined);
      throw new ConnectorAttachmentError(
        `ChatGPT did not show the connector "${name}" in the @ mention menu. ` +
          `Create a custom MCP connector with exactly this name, enable Developer Mode, ` +
          `and make sure the temporary chat uses personalized mode (plugins are unavailable ` +
          `in unpersonalized temporary chats).`,
      );
    }

    const visibleExact = exact.filter({ visible: true });
    const count = await visibleExact.count();
    if (count !== 1) {
      throw new ConnectorAttachmentError(
        `ChatGPT exposed ${count} connector menu rows named "${name}"; expected exactly one.`,
      );
    }

    // Click the exact row instead of relying on keyboard highlighting, which
    // can be absent in background chats and in newer mention menus.
    await visibleExact.first().click();
    await page.waitForTimeout(500);

    let selected = await this.activeComposer(30_000);
    const pill = this.connectorPill(selected).first();
    await pill
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => undefined);

    if (!(await this.connectorSelected(selected))) {
      // Some accounts show a one-time "Allow ChatGPT to use …?" card before the
      // connector pill appears. Click Allow once if the harness is allowed to.
      if (this.config.autoApproveToolCalls) {
        await this.autoApproveToolCallUnlocked();
        await page.waitForTimeout(600);
        selected = await this.activeComposer(30_000);
      }
    }

    if (!(await this.connectorSelected(selected))) {
      throw new ConnectorAttachmentError(
        `ChatGPT did not attach the "${name}" connector to the composer.`,
      );
    }

    this.events.emit({
      type: "notice",
      level: "info",
      text: `Attached connector: ${name}`,
    });
    return selected;
  }

  private async ensureTemporaryPersonalization(): Promise<void> {
    if (!this.config.useTemporaryChat) return;
    const page = this.requirePage();
    // New chats can expose personalization as a toolbar menu, without a modal.
    const unpersonalized = page.getByRole("button", { name: /^(?:Unpersonalized|Без персонализации|Неперсонализированный|非个性化)\s*$/i }).first();
    if (await unpersonalized.isVisible().catch(() => false)) await unpersonalized.click();
    const dialogs = page.locator(selectors.connectorDialog.join(", "));
    const deadline = Date.now() + 3_000;
    let chooser: Locator | undefined;

    while (!chooser && Date.now() < deadline) {
      const count = await dialogs.count();
      for (let index = 0; index < count; index += 1) {
        const dialog = dialogs.nth(index);
        if (!(await dialog.isVisible().catch(() => false))) continue;
        const text = await dialog.innerText().catch(() => "");
        if (/personaliz|персонализ|персонали|个性化/i.test(text)) {
          chooser = dialog;
          break;
        }
      }
      if (!chooser) await page.waitForTimeout(150);
    }

    if (!chooser) return;

    const options = [
      /^\s*Personalized\s*$/i,
      /^\s*Personalize\s*$/i,
      /^\s*С персонализацией\s*$/i,
      /^\s*Персонализированный\s*$/i,
      /^\s*个性化\s*$/i,
    ];
    for (const pattern of options) {
      const option = chooser.getByText(pattern).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click().catch(() => undefined);
        await page.waitForTimeout(400);
        this.events.emit({
          type: "notice",
          level: "info",
          text: "Temporary chat set to personalized so the MCP connector is available.",
        });
        return;
      }
    }

    this.events.emit({
      type: "notice",
      level: "warn",
      text:
        "Temporary chat is using unpersonalized mode; custom connectors are unavailable there. " +
        "Choose Personalized for temporary chats in ChatGPT or set browser.useTemporaryChat=false.",
    });
  }

  private async waitForSendEnabled(timeoutMs: number): Promise<boolean> {
    const page = this.requirePage();
    const button = await this.firstVisible("sendButton");
    if (!button) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await button.isEnabled().catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    return false;
  }

  private async clickSend(): Promise<void> {
    const page = this.requirePage();
    const button = await this.waitForAny("sendButton", 15_000);
    if (button) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await button.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(250);
      }
      if (await button.isEnabled().catch(() => false)) {
        await button.click();
        return;
      }
    }

    const composer = await this.firstVisible("composer");
    if (!composer) throw new Error("Send button and composer are both unavailable.");
    await composer.press("Enter");
  }

  private async waitForResponseStart(timeoutMs: number, signal: AbortSignal, initialToolEpoch: number): Promise<void> {
    const page = this.requirePage();
    let lastApprovalCheck = 0;
    let warned = false;
    let browserApproval = false;
    const startedAt = Date.now();
    let lastWaitingNoticeAt = startedAt;
    while (true) {
      signal.throwIfAborted();
      if (page.isClosed()) throw new Error("Browser page closed after sending. The request may have been received; check the conversation before retrying.");
      if (this.toolEpoch !== initialToolEpoch) return;
      if (await this.firstVisible("stopButton")) { this.sawStopButton = true; return; }
      if ((await this.count("assistantMessage")) > this.baseline) return;
      if (await this.requirePage().locator(selectors.markdown.join(", ")).count() > this.baselineMarkdown) return;
      if (await this.responseAfterSubmittedPrompt()) return;
      if (Date.now() - lastApprovalCheck >= 2_000) {
        lastApprovalCheck = Date.now();
        if (this.config.autoApproveToolCalls) await this.autoApproveToolCall();
        const approval = await this.hasBrowserApproval();
        if (approval !== browserApproval) {
          browserApproval = approval;
          this.events.emit({ type: "phase", phase: approval ? "waiting-approval" : "thinking" });
          if (approval) this.events.emit({ type: "notice", level: "warn", text: "ChatGPT is waiting for approval in the browser. Check the browser window." });
        }
      }
      if (!warned && Date.now() - startedAt >= 30_000 && !browserApproval) {
        warned = true;
        this.events.emit({ type: "notice", level: "warn", text: "Waiting for ChatGPT to start. Check the browser and use /status for diagnostics." });
      }
      if (!browserApproval && Date.now() - lastWaitingNoticeAt >= timeoutMs) {
        lastWaitingNoticeAt = Date.now();
        this.events.emit({ type: "notice", level: "info", text: "ChatGPT has not visibly started yet. Continuing to wait for this same request; use Esc or /stop to cancel." });
      }
      await page.waitForTimeout(250);
    }
  }

  async diagnostics(): Promise<string> {
    if (!this.isOpen) return "Browser: disconnected. Use /login to reconnect; no request is sent automatically.";
    const stop = Boolean(await this.firstVisible("stopButton"));
    const composer = Boolean(await this.firstVisible("composer"));
    const approval = await this.hasBrowserApproval();
    const age = this.lastProgressAt ? `${Math.floor((Date.now() - this.lastProgressAt) / 1000)}s ago` : "none recorded";
    return `Browser: connected\nStop button: ${stop ? "visible" : "not visible"}\nComposer: ${composer ? "visible" : "not visible"}\nBrowser approval: ${approval ? "waiting" : "none detected"}\nLocal tools: ${this.activeToolCalls.size} running, ${this.preparingToolCalls} preparing\nLocal approvals: ${this.pendingApprovals.size}\nLast response progress: ${age}\nThese are observations of the Web UI; they do not guarantee that a remote action stopped.`;
  }

  async listInteractiveControls(): Promise<string> {
    const controls = await this.collectInteractiveControls(true);
    if (!controls.length) return "No visible interactive controls were found in the latest ChatGPT response.";
    return `Visible controls in the latest ChatGPT response (IDs expire after the next page change):\n${controls.map(({ id, description }) => `- ${id}: ${description}`).join("\n")}\n\nUse interact_with_chatgpt with a listed ID. The original user's request and harness approval mode still apply.`;
  }

  async hasInteractiveControls(): Promise<boolean> {
    return (await this.collectInteractiveControls(false)).length > 0;
  }

  async interactWithControl(controlId: string, action: "click" | "fill" | "select" | "check" | "uncheck", value?: string): Promise<string> {
    return withBrowserUi(this.requirePage().context(), () => this.interactWithControlUnlocked(controlId, action, value));
  }

  private async interactWithControlUnlocked(controlId: string, action: "click" | "fill" | "select" | "check" | "uncheck", value?: string): Promise<string> {
    const control = this.interactiveControls.get(controlId);
    if (!control) throw new Error("That control ID has expired. Call list_chatgpt_controls again.");
    if (!(await control.isVisible().catch(() => false)) || !(await control.isEnabled().catch(() => false))) {
      this.interactiveControls.clear();
      throw new Error("That control is no longer available or enabled. Call list_chatgpt_controls again.");
    }
    const details = await control.evaluate((element) => {
      const node = element as HTMLElement;
      const input = node instanceof HTMLInputElement ? node : undefined;
      return {
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") ?? "",
        type: input?.type ?? "",
        editable: node.isContentEditable,
        checked: input?.checked ?? node.getAttribute("aria-checked") === "true",
      };
    });
    if (action === "click") {
      if (details.tag !== "button" && details.role !== "button" && details.role !== "option" && details.role !== "menuitem" && !(details.tag === "input" && ["button", "submit", "reset"].includes(details.type))) throw new Error("Only a button, menu item or option can be clicked.");
      await control.click();
    } else if (action === "fill") {
      if (details.type === "password" || (details.tag === "input" && !["text", "search", "email", "url", "tel", "number"].includes(details.type)) || !(details.tag === "textarea" || details.tag === "input" || details.role === "textbox" || details.editable)) throw new Error("Only a visible text field can be filled; password fields are not supported.");
      await control.fill(value ?? "");
    } else if (action === "select") {
      if (details.tag !== "select") throw new Error("Select requires a visible native select field.");
      await control.selectOption(value ?? "");
    } else {
      if (details.type !== "checkbox" && details.type !== "radio" && details.role !== "checkbox" && details.role !== "radio") throw new Error("Check and uncheck require a checkbox or radio button.");
      if (action === "check") await control.check();
      else await control.uncheck();
    }
    this.interactiveControls.clear();
    this.lastInteraction += 1;
    await this.page?.waitForTimeout(200).catch(() => undefined);
    return `${action} completed for ${controlId}. Inspect the page again to confirm the result.`;
  }

  private async collectInteractiveControls(assignIds: boolean): Promise<Array<{ id: string; description: string }>> {
    const page = this.page;
    if (!page || page.isClosed()) return [];
    if (assignIds) this.interactiveControls.clear();
    const selector = 'button, input:not([type="hidden"]), textarea, select, [role="button"], [role="menuitem"], [role="option"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
    const scopes: Array<{ root: Locator; frameName: string; responseRoot?: Locator }> = [];
    if (this.interactiveAnchor && await this.interactiveAnchor.count().catch(() => 0)) scopes.push({ root: this.interactiveAnchor, frameName: "page", responseRoot: this.interactiveAnchor });
    else {
      this.interactiveAnchor = undefined;
      const messages = page.locator(selectors.assistantMessage.join(", "));
      const count = await messages.count().catch(() => 0);
      for (let index = this.baseline; index < count; index += 1) {
        const root = messages.nth(index);
        scopes.push({ root, frameName: "page", responseRoot: root });
      }
    }
    if (!scopes.length) return [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const element = await frame.frameElement();
        let responseRoot = this.interactiveAnchor;
        let belongsToResponse = false;
        if (responseRoot) {
          const anchor = await responseRoot.elementHandle().catch(() => undefined);
          belongsToResponse = Boolean(anchor && await element.evaluate((node, root) => root instanceof Element && root.contains(node), anchor));
        } else {
          for (const scope of scopes.filter((item) => item.frameName === "page")) {
            const anchor = await scope.root.elementHandle().catch(() => undefined);
            if (anchor && await element.evaluate((node, root) => root instanceof Element && root.contains(node), anchor)) {
              responseRoot = scope.root;
              belongsToResponse = true;
              break;
            }
          }
        }
        if (belongsToResponse) scopes.push({ root: frame.locator("body"), frameName: frame.name() || "embedded app", responseRoot });
      } catch { /* Ignore detached or cross-origin frames. */ }
    }
    const found: Array<{ locator: Locator; description: string }> = [];
    for (const { root, frameName } of scopes) {
      const controls = root.locator(selector);
      const size = await controls.count().catch(() => 0);
      let foundInScope = false;
      for (let index = 0; index < size && found.length < 80; index += 1) {
        const locator = controls.nth(index);
        if (!(await locator.isVisible().catch(() => false))) continue;
        const info = await locator.evaluate((element) => {
          const node = element as HTMLElement;
          if (node.closest('[hidden], [aria-hidden="true"], [inert]')) return null;
          const input = node instanceof HTMLInputElement ? node : undefined;
          const select = node instanceof HTMLSelectElement ? node : undefined;
          if (input?.type === "password" || input?.type === "hidden") return null;
          const label = node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.getAttribute("title") || input?.labels?.[0]?.innerText || node.innerText || node.textContent || "";
          if (node.tagName === "BUTTON" && /^(?:copy|copy message|good response|bad response|read aloud|regenerate|share|more actions|undo|redo|fullscreen|expand|collapse|show more|show less|копировать|хороший ответ|плохой ответ|прочитать вслух|повторить|поделиться|отменить|вернуть|развернуть|свернуть|показать больше|показать меньше)$/i.test(label.trim())) return null;
          if (node.tagName === "BUTTON" && /(?:message-actions|feedback|copy-button|read-aloud|regenerate-button)/i.test(`${node.getAttribute("data-testid") ?? ""} ${node.className}`)) return null;
          const value = input?.value ?? (node instanceof HTMLTextAreaElement ? node.value : select ? select.selectedOptions[0]?.label ?? select.value : node.isContentEditable ? node.innerText : "");
          const checked = input?.checked ?? node.getAttribute("aria-checked") === "true";
          return {
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute("role") || "",
            type: input?.type || "",
            label: label.trim().replace(/\s+/g, " ").slice(0, 160),
            value: value.trim().replace(/\s+/g, " ").slice(0, 240),
            checked,
            disabled: (node as HTMLButtonElement).disabled || node.getAttribute("aria-disabled") === "true",
          };
        }).catch(() => null);
        if (!info) continue;
        const id = `c${found.length + 1}`;
        const kind = info.role || info.type || info.tag;
        const label = info.label || "unlabelled control";
        const state = info.disabled ? "disabled" : "enabled";
        const value = info.value ? `; current value: ${JSON.stringify(info.value)}` : "";
        const checked = info.type === "checkbox" || info.type === "radio" || info.role === "checkbox" || info.role === "radio" ? `; ${info.checked ? "checked" : "not checked"}` : "";
        found.push({ locator, description: `${kind} ${JSON.stringify(label)} (${state}${checked}${value})${frameName === "page" ? "" : ` [${frameName}]`}` });
        if (assignIds) this.interactiveControls.set(id, locator);
        foundInScope = true;
      }
      if (foundInScope && !this.interactiveAnchor) this.interactiveAnchor = frameName === "page" ? root : scopes.find((item) => item.root === root)?.responseRoot;
    }
    if (this.interactiveAnchor && !found.length) {
      this.interactiveAnchor = undefined;
      return this.collectInteractiveControls(assignIds);
    }
    return found.map(({ description }, index) => ({ id: `c${index + 1}`, description }));
  }

  private async lastAssistantText(): Promise<string> {
    const page = this.requirePage();
    const messages = page.locator(selectors.assistantMessage.join(", "));
    const count = await messages.count();
    const answers: string[] = [];
    for (let index = this.baseline; index < count; index += 1) {
      const message = messages.nth(index);
      const markdowns = message.locator(selectors.markdown.join(", "));
      const markdownCount = await markdowns.count();
      if (markdownCount > 0) {
        const parts: string[] = [];
        for (let partIndex = 0; partIndex < markdownCount; partIndex += 1) {
          const part = removeResponseStatus(await readMarkdown(markdowns.nth(partIndex)));
          if (part) parts.push(part);
        }
        if (parts.length > 0) {
          answers.push(parts.join("\n\n"));
        }
        // An empty Markdown node is often a still-loading tool/status card.
        // Its parent innerText includes web UI labels, not an answer.
        continue;
      }
      const fallback = await readFallbackText(message);
      const content = cleanBrowserFallback(removeObservedActivity(fallback.text, fallback.activityLabels));
      if (content) answers.push(content);
    }
    if (answers.length > 0) return answers.join("\n\n");
    if (count > this.baseline) return "";

    // ChatGPT's web UI can briefly render a completed answer outside the
    // message-role container. Only inspect markdown nodes added this turn.
    const allMarkdown = page.locator(selectors.markdown.join(", "));
    const markdownCount = await allMarkdown.count();
    for (let index = this.baselineMarkdown; index < markdownCount; index += 1) {
      const content = cleanBrowserFallback(await readMarkdown(allMarkdown.nth(index)));
      if (content) answers.push(content);
    }
    if (answers.length > 0) return answers.join("\n\n");
    return this.responseAfterSubmittedPrompt();
  }

  private async responseAfterSubmittedPrompt(): Promise<string> {
    if (!this.submittedPrompt) return "";
    const page = this.page;
    if (!page || page.isClosed()) return "";
    const mains = page.locator("main");
    if ((await mains.count().catch(() => 0)) === 0) return "";
    const main = mains.last();
    const fallback = await readFallbackText(main);
    return removeObservedActivity(extractResponse(fallback.text, this.submittedPrompt), fallback.activityLabels).trim();
  }

  private async isStreaming(): Promise<boolean> {
    // The send button may coexist with the stop button, and can be disabled
    // simply because the composer is empty after a completed response.
    if (await this.firstVisible("stopButton")) {
      this.sawStopButton = true;
      return true;
    }
    const messages = this.requirePage().locator(selectors.assistantMessage.join(", "));
    const latest = messages.last();
    const hasCurrentMessage = await messages.count() > this.baseline;
    // A completed response may leave an empty, disabled Send button. A visible
    // response action also confirms completion when a very fast response was
    // never observed with Stop mounted.
    const turn = latest.locator('xpath=ancestor-or-self::*[self::article or starts-with(@data-testid,"conversation-turn-")][1]');
    const actions = turn.locator('[data-testid="copy-turn-action-button"], [data-testid="good-response-turn-action-button"], [data-testid="bad-response-turn-action-button"]');
    if (hasCurrentMessage) for (let index = 0; index < await actions.count(); index++) if (await actions.nth(index).isVisible().catch(() => false)) return false;
    if (hasCurrentMessage && await latest.isVisible().catch(() => false)) {
      const raw = (await latest.innerText().catch(() => "")).trim();
      // A stale generic "ChatGPT is responding" label may remain after an
      // observed Stop disappears on a tool-only response. Bare Thinking is a
      // reasoning placeholder and must never establish completion by itself.
      if (raw && !removeResponseStatus(raw) && (!this.sawStopButton || !/^ChatGPT\s/i.test(raw))) return true;
    }
    const send = await this.firstVisible("sendButton");
    if (send && await send.isEnabled().catch(() => false)) return false;
    if (this.sawStopButton && await this.firstVisible("composer")) return false;
    return true;
  }

  private async hasBrowserApproval(): Promise<boolean> {
    const page = this.requirePage();
    for (const selector of selectors.allowButton) {
      const buttons = page.locator(selector);
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        if (await buttons.nth(index).isVisible().catch(() => false)) return true;
      }
    }
    const dialogs = page.locator('[role="dialog"]');
    const count = await dialogs.count();
    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = await dialog.innerText().catch(() => "");
      if (/allow|permission|approv|confirm|разреш|подтверд/i.test(text)) return true;
    }
    return false;
  }

  private async stopStalledResponse(signal: AbortSignal, canRecover: () => boolean): Promise<boolean> {
    const page = this.requirePage();
    const stop = await this.firstVisible("stopButton");
    if (!stop || this.activeToolCalls.size > 0 || this.preparingToolCalls > 0 || this.pendingApprovals.size > 0 || !canRecover()) return false;
    try {
      await stop.click({ timeout: 3_000 });
    } catch {
      return false;
    }
    const deadline = Date.now() + 10_000;
    let idleSince = 0;
    let lastToolEpoch = this.toolEpoch;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const browserApproval = await this.hasBrowserApproval();
      const streaming = await this.isStreaming();
      const quiet = this.activeToolCalls.size === 0 && this.preparingToolCalls === 0 && this.pendingApprovals.size === 0 && canRecover() && !browserApproval && !streaming;
      if (quiet) {
        if (!idleSince || lastToolEpoch !== this.toolEpoch) idleSince = Date.now();
        if (Date.now() - idleSince >= 2_000) return true;
      } else {
        idleSince = 0;
      }
      lastToolEpoch = this.toolEpoch;
      await page.waitForTimeout(250);
    }
    return false;
  }

  private async autoApproveToolCall(): Promise<void> {
    return withBrowserUi(this.requirePage().context(), () => this.autoApproveToolCallUnlocked(), this.responseSignal);
  }

  private async autoApproveToolCallUnlocked(): Promise<void> {
    const page = this.requirePage();
    for (const selector of selectors.allowButton) {
      const buttons = page.locator(selector);
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (!(await button.isVisible().catch(() => false))) continue;
        const label = (await button.innerText().catch(() => "")).trim();
        if (/always/i.test(label)) continue;
        await button.click().catch(() => undefined);
        this.events.emit({
          type: "notice",
          level: "info",
          text: `Clicked ChatGPT tool approval: ${label || "Allow"}`,
        });
        await page.waitForTimeout(300);
        return;
      }
    }
  }

  private async firstVisible(group: SelectorGroup): Promise<Locator | undefined> {
    const page = this.requirePage();
    for (const selector of selectors[group]) {
      const locators = page.locator(selector);
      const count = await locators.count();
      for (let index = 0; index < count; index += 1) {
        const locator = locators.nth(index);
        if (await locator.isVisible().catch(() => false)) return locator;
      }
    }
    return undefined;
  }

  private async waitForAny(
    group: SelectorGroup,
    timeoutMs: number,
  ): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.firstVisible(group);
      if (found) return found;
      const page = this.page;
      if (!page || page.isClosed()) return undefined;
      await page.waitForTimeout(250);
    }
    return undefined;
  }

  private async count(group: SelectorGroup): Promise<number> {
    const page = this.requirePage();
    return page.locator(selectors[group].join(", ")).count();
  }

  private emitSession(): void {
    const page = this.page;
    if (!page) return;
    this.events.emit({
      type: "session",
      session: {
        url: page.url(),
        temporary: this.config.useTemporaryChat,
        model: this.config.modelLabel || undefined,
        effort: this.config.effortLabel || undefined,
      },
    });
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error("Browser is not connected. Call connect() first.");
    }
    return this.page;
  }
}

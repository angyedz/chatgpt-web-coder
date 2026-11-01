import { setTimeout as delay } from "node:timers/promises";
import type { HarnessEvents } from "../events.js";
import type { ApprovalRequest, HarnessEvent, TurnPhase } from "../types.js";
import type { TelegramConfig } from "../config.js";

const API = "https://api.telegram.org/bot";
const MAX_MESSAGE = 4096;
const MAX_PROMPT = 3500;
const EDIT_INTERVAL_MS = 3000;
const PROMPT_COOLDOWN_MS = 3000;
const POLL_TIMEOUT_SECONDS = 25;

interface TelegramUser { id: number; username?: string }
interface TelegramChat { id: number; type: string }
interface TelegramMessage { message_id: number; chat: TelegramChat; from?: TelegramUser; text?: string }
interface TelegramCallbackQuery { id: string; from: TelegramUser; data?: string; message?: TelegramMessage }
interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
interface TelegramBotIdentity { id: number; first_name: string; username?: string }
interface TelegramApiResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }
interface TelegramKeyboard { inline_keyboard: { text: string; callback_data: string }[][] }

export interface TelegramBotCallbacks {
  events: HarnessEvents;
  workspace: string;
  getBusy(): boolean;
  getPhase(): TurnPhase;
  submit(text: string): boolean;
  cancel(): void;
  approve(id: string, allowed: boolean): void;
  onStatus(state: "starting" | "up" | "off" | "error", detail?: string): void;
  onPaired(profile: TelegramConfig): Promise<void>;
  saveProfile(patch: Partial<TelegramConfig>): void;
  onPairExpired(): void;
}

export class TelegramBot {
  private identity?: TelegramConfig;
  private readonly pairingCode?: string;
  private readonly pairExpiresAt?: number;
  private readonly pairFailures = new Map<number, number>();
  private readonly abort = new AbortController();
  private readonly pendingApprovals = new Map<string, ApprovalRequest>();
  private readonly unsubscribe: () => void;
  private readonly token: string;
  private me?: TelegramBotIdentity;
  private offset: number;
  private polling?: Promise<void>;
  private running = false;
  private requestActive = false;
  private requestPrompt = "";
  private activeTurnId?: string;
  private activeTurnIsTelegram = false;
  private answer = "";
  private lastNotice = "";
  private phase = "Ready";
  private lastPromptAt = 0;
  private pairTotalFailures = 0;
  private dashboardMessageId = 0;
  private lastEditAt = 0;
  private lastRendered = "";
  private lastKeyboard = "";
  private editTimer?: NodeJS.Timeout;
  private editRevision = 0;
  private editing = false;

  constructor(token: string, identity: TelegramConfig | undefined, pairingCode: string | undefined, private readonly callbacks: TelegramBotCallbacks) {
    this.token = token;
    this.identity = identity?.enabled ? identity : undefined;
    this.pairingCode = pairingCode;
    this.pairExpiresAt = pairingCode ? Date.now() + 10 * 60_000 : undefined;
    this.offset = identity?.updateOffset ?? 0;
    if (callbacks.getBusy()) this.phase = `Local · ${phaseName(callbacks.getPhase())}`;
    this.dashboardMessageId = identity?.dashboardMessageId ?? 0;
    this.unsubscribe = callbacks.events.on((event) => this.onAgentEvent(event));
  }

  get botUsername(): string { return this.me?.username ?? this.identity?.botUsername ?? ""; }
  get isRunning(): boolean { return this.running; }

  async start(): Promise<void> {
    if (this.running) return;
    this.callbacks.onStatus("starting", "Telegram bot");
    const response = await this.api<TelegramBotIdentity>("getMe");
    this.me = response;
    const commands = this.identity
      ? [
          { command: "start", description: "Open harness controls" },
          { command: "help", description: "Show available commands" },
          { command: "status", description: "Show harness status" },
          { command: "stop", description: "Stop the current task" },
        ]
      : [{ command: "pair", description: "Pair this private chat with the local harness" }];
    await this.api("setMyCommands", { commands });
    this.running = true;
    this.callbacks.onStatus("up", response.username ? `@${response.username}` : response.first_name);
    if (this.identity) {
      await this.updateDashboard(true);
    }
    this.polling = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    if (this.editTimer) clearTimeout(this.editTimer);
    this.editTimer = undefined;
    this.unsubscribe();
    await this.polling?.catch(() => undefined);
    this.callbacks.onStatus("off");
  }

  private async pollLoop(): Promise<void> {
    let backoff = 1500;
    while (this.running && !this.abort.signal.aborted) {
      if (!this.identity && this.pairExpiresAt && Date.now() >= this.pairExpiresAt) {
        this.running = false;
        this.abort.abort();
        this.callbacks.onStatus("off");
        this.callbacks.onPairExpired();
        return;
      }
      try {
        const updates = await this.api<TelegramUpdate[]>("getUpdates", {
          ...(this.offset ? { offset: this.offset } : {}),
          limit: 50,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message", "callback_query"],
        }, this.abort.signal);
        backoff = 1500;
        for (const update of updates) {
          if (!this.running || this.abort.signal.aborted) break;
          if (update.update_id < this.offset) continue;
          this.offset = update.update_id + 1;
          await this.onUpdate(update);
        }
      } catch (error) {
        if (this.abort.signal.aborted) break;
        const apiError = error instanceof TelegramApiError ? error : undefined;
        this.callbacks.onStatus("error", safeDetail(error, this.token));
        if (apiError?.status === 409) {
          this.running = false;
          this.callbacks.onStatus("error", "Another bot process or a webhook is already consuming updates.");
          break;
        }
        if (apiError?.status === 401 || apiError?.status === 404) {
          this.running = false;
          break;
        }
        const waitMs = apiError?.retryAfter ? Math.max(backoff, apiError.retryAfter * 1000) : backoff;
        try { await delay(waitMs, undefined, { signal: this.abort.signal }); } catch { break; }
        backoff = Math.min(30_000, backoff * 2);
        if (this.running) this.callbacks.onStatus("up", this.botUsername ? `@${this.botUsername}` : "Telegram bot");
      }
    }
  }

  private async onUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message) await this.onMessage(message, update.update_id);
    const callback = update.callback_query;
    if (callback) await this.onCallback(callback, update.update_id);
  }

  private async onMessage(message: TelegramMessage, updateId: number): Promise<void> {
    if (message.chat.type !== "private" || !message.from || typeof message.text !== "string") return;
    const text = message.text.trim();
    if (!this.identity) {
      await this.tryPair(message, text, updateId);
      return;
    }
    if (!this.isOwner(message.from.id, message.chat.id)) return;
    this.persistOffset(updateId);
    if (!text) return;
    const commandMatch = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    const command = commandMatch?.[1]?.toLowerCase();
    if (command) {
      switch (command) {
        case "start":
        case "help":
          this.lastNotice = "Use /status to check the harness, /stop to cancel its current task, or send a message to start work.";
          this.queueDashboard();
          return;
        case "status":
          this.lastNotice = "Status refreshed.";
          this.queueDashboard();
          return;
        case "stop":
        case "cancel":
          if (!this.callbacks.getBusy()) this.lastNotice = "There is no active task to stop.";
          else { this.callbacks.cancel(); this.lastNotice = "Stopping the active task…"; }
          this.queueDashboard();
          return;
        default:
          this.lastNotice = "Unknown command. Use /help, /status, /stop, or send a task as a regular message.";
          this.queueDashboard();
          return;
      }
    }
    if (text.includes(this.token)) {
      this.lastNotice = "For safety, bot tokens are accepted only in the masked setup field inside the harness.";
      this.queueDashboard();
      return;
    }
    if (text.length > MAX_PROMPT) {
      this.lastNotice = `Message is too long (${text.length} characters). Send a task up to ${MAX_PROMPT} characters.`;
      this.queueDashboard();
      return;
    }
    if (this.callbacks.getBusy() || this.requestActive) {
      this.lastNotice = "The harness is already working. Use /stop before sending another task.";
      this.queueDashboard();
      return;
    }
    const now = Date.now();
    if (now - this.lastPromptAt < PROMPT_COOLDOWN_MS) {
      this.lastNotice = "Please wait a moment before sending another task.";
      this.queueDashboard();
      return;
    }
    this.lastPromptAt = now;
    this.requestActive = true;
    this.requestPrompt = text;
    this.answer = "";
    this.lastNotice = "Task sent to the harness.";
    this.phase = "Sending";
    if (!this.callbacks.submit(text)) {
      this.requestActive = false;
      this.lastNotice = "The harness is busy. Use /stop or wait for the current task to finish.";
    }
    this.queueDashboard();
  }

  private async tryPair(message: TelegramMessage, text: string, updateId: number): Promise<void> {
    const match = /^\/pair(?:@\w+)?\s+(\d{8})$/.exec(text);
    if (!match || !this.pairingCode || !this.pairExpiresAt || Date.now() > this.pairExpiresAt) return;
    const attempts = (this.pairFailures.get(message.from!.id) ?? 0) + 1;
    this.pairFailures.set(message.from!.id, attempts);
    this.pairTotalFailures += 1;
    if (attempts > 5 || this.pairTotalFailures > 20) return;
    if (match[1] !== this.pairingCode) return;
    const profile: TelegramConfig = {
      enabled: true,
      ownerUserId: String(message.from!.id),
      ownerChatId: String(message.chat.id),
      botUsername: this.me?.username ?? "",
      dashboardMessageId: 0,
      updateOffset: updateId + 1,
    };
    await this.callbacks.onPaired(profile);
    this.identity = profile;
    this.offset = updateId + 1;
    this.lastNotice = "Private chat paired. Send a message to start a task.";
    await this.updateDashboard(true);
  }

  private async onCallback(callback: TelegramCallbackQuery, updateId: number): Promise<void> {
    const chatId = callback.message?.chat.id;
    if (!this.identity || !callback.message || callback.message.chat.type !== "private" || !this.isOwner(callback.from.id, chatId)) {
      await this.api("answerCallbackQuery", { callback_query_id: callback.id, text: "Not authorized." }).catch(() => undefined);
      return;
    }
    this.persistOffset(updateId);
    const data = callback.data ?? "";
    if (data === "status") {
      this.lastNotice = "Status refreshed.";
    } else if (data === "stop") {
      if (this.callbacks.getBusy()) { this.callbacks.cancel(); this.lastNotice = "Stopping the active task…"; }
      else this.lastNotice = "There is no active task to stop.";
    } else if (data.startsWith("approval:")) {
      const rest = data.slice("approval:".length);
      const separator = rest.lastIndexOf(":");
      const id = separator > 0 ? rest.slice(0, separator) : "";
      const value = separator > 0 ? rest.slice(separator + 1) : "";
      const approval = id ? this.pendingApprovals.get(id) : undefined;
      if (approval && (value === "yes" || value === "no")) {
        this.callbacks.approve(approval.id, value === "yes");
        this.pendingApprovals.delete(approval.id);
        this.lastNotice = value === "yes" ? "Approval granted from Telegram." : "Action denied from Telegram.";
      }
    }
    await this.api("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
    this.queueDashboard();
  }

  private isOwner(userId: number, chatId: number | undefined): boolean {
    return Boolean(this.identity && String(userId) === this.identity.ownerUserId && String(chatId) === this.identity.ownerChatId);
  }

  private persistOffset(updateId: number): void {
    if (!this.identity) return;
    this.identity.updateOffset = updateId + 1;
    this.callbacks.saveProfile({ updateOffset: this.identity.updateOffset });
  }

  private onAgentEvent(event: HarnessEvent): void {
    if (!this.identity) return;
    switch (event.type) {
      case "turn-start":
        this.activeTurnId = event.turnId;
        this.activeTurnIsTelegram = this.requestActive;
        if (!this.requestActive) {
          this.phase = `Local · ${phaseName(this.callbacks.getPhase())}`;
          this.queueDashboard();
        }
        break;
      case "phase":
        if (this.requestActive) this.phase = phaseName(event.phase);
        else if (event.phase === "idle") {
          if (this.phase.startsWith("Local ·")) this.phase = "Ready";
        } else this.phase = `Local · ${phaseName(event.phase)}`;
        this.queueDashboard();
        break;
      case "assistant-delta":
        if (!this.requestActive || event.channel !== "telegram") return;
        this.phase = "Responding";
        this.answer = event.text;
        this.queueDashboard();
        break;
      case "tool-start":
        if (!this.requestActive) this.phase = `Local · using ${event.call.name}`;
        this.queueDashboard();
        break;
      case "approval":
        this.pendingApprovals.set(event.request.id, event.request);
        this.phase = `${this.requestActive ? "" : "Local · "}Waiting for approval`;
        this.lastNotice = "Review the pending action below and choose Approve or Deny.";
        this.queueDashboard();
        break;
      case "approval-resolved":
        this.pendingApprovals.delete(event.id);
        this.queueDashboard();
        break;
      case "turn-end":
        if (!this.activeTurnId || event.turnId !== this.activeTurnId) return;
        if (this.activeTurnIsTelegram) this.requestActive = false;
        this.activeTurnId = undefined;
        this.activeTurnIsTelegram = false;
        this.phase = event.ok ? "Completed" : "Stopped or failed";
        if (!event.ok && !this.answer) this.answer = "The task ended without a final response. Check the harness for details.";
        this.queueDashboard();
        break;
      default:
        break;
    }
  }

  private queueDashboard(): void {
    if (!this.identity || !this.running) return;
    this.editRevision += 1;
    if (this.editTimer) clearTimeout(this.editTimer);
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastEditAt));
    this.editTimer = setTimeout(() => { this.editTimer = undefined; void this.flushDashboard(); }, wait);
    this.editTimer.unref?.();
  }

  private async updateDashboard(force: boolean): Promise<void> {
    if (!this.identity || !this.running) return;
    if (force) this.lastRendered = "";
    await this.flushDashboard();
  }

  private async flushDashboard(): Promise<void> {
    if (!this.identity || !this.running || this.editing) return;
    const revision = this.editRevision;
    const text = this.renderDashboard();
    const keyboard = this.renderKeyboard();
    const keyboardKey = JSON.stringify(keyboard);
    if (text === this.lastRendered && keyboardKey === this.lastKeyboard) return;
    const wait = EDIT_INTERVAL_MS - (Date.now() - this.lastEditAt);
    if (wait > 0) {
      this.editTimer = setTimeout(() => { this.editTimer = undefined; void this.flushDashboard(); }, wait);
      this.editTimer.unref?.();
      return;
    }
    this.editing = true;
    try {
      if (!this.dashboardMessageId) {
        const sent = await this.api<{ message_id: number }>("sendMessage", {
          chat_id: this.identity.ownerChatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: keyboard,
        });
        this.dashboardMessageId = sent.message_id;
        this.callbacks.saveProfile({ dashboardMessageId: sent.message_id });
      } else {
        try {
          await this.api("editMessageText", {
            chat_id: this.identity.ownerChatId,
            message_id: this.dashboardMessageId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: keyboard,
          });
        } catch (error) {
          if (!(error instanceof TelegramApiError) || !/message to edit not found|message can't be edited|message_id_invalid/i.test(error.message)) throw error;
          this.dashboardMessageId = 0;
          this.callbacks.saveProfile({ dashboardMessageId: 0 });
          this.editing = false;
          this.queueDashboard();
          return;
        }
      }
      this.lastRendered = text;
      this.lastKeyboard = keyboardKey;
      this.lastEditAt = Date.now();
      this.lastNotice = "";
    } catch (error) {
      const retry = error instanceof TelegramApiError && error.retryAfter ? error.retryAfter * 1000 : EDIT_INTERVAL_MS;
      this.callbacks.onStatus("error", safeDetail(error, this.token));
      this.editTimer = setTimeout(() => { this.editTimer = undefined; void this.flushDashboard(); }, retry);
      this.editTimer.unref?.();
    } finally {
      this.editing = false;
    }
    if (revision !== this.editRevision) this.queueDashboard();
  }

  private renderDashboard(): string {
    const lines = [
      "🤖 <b>chatgpt-coder</b>",
      `📂 <code>${escapeLimited(this.callbacks.workspace, 350)}</code>`,
      "",
      `${this.requestActive ? "⏳" : this.phase === "Completed" ? "✅" : this.phase === "Stopped or failed" ? "⚠️" : "🟢"} <b>${escapeLimited(this.requestActive ? this.phase : this.phase, 80)}</b>`,
    ];
    if (this.requestPrompt) lines.push("", "<b>Request</b>", `<blockquote>${formatTelegramText(this.requestPrompt.replaceAll(this.token, "[redacted]"), 500)}</blockquote>`);
    if (this.answer) lines.push("", "<b>Latest response</b>", `<blockquote>${formatTelegramText(this.answer.replaceAll(this.token, "[redacted]"), 1600)}</blockquote>`);
    if (this.pendingApprovals.size) {
      const approval = this.pendingApprovals.values().next().value as ApprovalRequest | undefined;
      if (approval) lines.push("", "🔐 <b>Approval needed</b>", `<blockquote>${escapeLimited(approval.summary, 450)}</blockquote>`);
    }
    if (this.lastNotice) lines.push("", `ℹ️ ${escapeLimited(this.lastNotice, 160)}`);
    const rendered = lines.join("\n");
    if (rendered.length <= MAX_MESSAGE) return rendered;
    const safeFallback = [
      "🤖 <b>chatgpt-coder</b>",
      `📂 <code>${escapeLimited(this.callbacks.workspace, 180)}</code>`,
      "",
      `<b>${escapeLimited(this.phase, 70)}</b>`,
      ...(this.requestPrompt ? ["", "<b>Request</b>", escapeLimited(this.requestPrompt.replaceAll(this.token, "[redacted]"), 500)] : []),
      ...(this.answer ? ["", "<b>Latest response</b>", escapeLimited(this.answer.replaceAll(this.token, "[redacted]"), 1500)] : []),
      ...(this.lastNotice ? ["", `ℹ️ ${escapeLimited(this.lastNotice, 160)}`] : []),
    ].join("\n");
    return safeFallback;
  }

  private renderKeyboard(): TelegramKeyboard {
    const rows: TelegramKeyboard["inline_keyboard"] = [[
      { text: "↻ Status", callback_data: "status" },
      { text: "■ Stop", callback_data: "stop" },
    ]];
    const approval = this.pendingApprovals.values().next().value as ApprovalRequest | undefined;
    if (approval) rows.push([
      { text: "✓ Approve", callback_data: `approval:${approval.id}:yes` },
      { text: "✕ Deny", callback_data: `approval:${approval.id}:no` },
    ]);
    return { inline_keyboard: rows };
  }

  private async api<T = unknown>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let response: Response;
    const timeout = AbortSignal.timeout((method === "getUpdates" ? POLL_TIMEOUT_SECONDS + 15 : 15) * 1000);
    try {
      response = await fetch(`${API}${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new Error(safeDetail(error, this.token));
    }
    let data: TelegramApiResponse<T>;
    try { data = await response.json() as TelegramApiResponse<T>; }
    catch { throw new Error(`Telegram API ${method} returned an unreadable response.`); }
    if (!response.ok || !data.ok || data.result === undefined) {
      throw new TelegramApiError(data.description ?? `Telegram API ${method} failed (${response.status}).`, data.error_code ?? response.status, data.parameters?.retry_after);
    }
    return data.result;
  }
}

class TelegramApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}

function escapeLimited(value: string, maxOutput: number): string {
  const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  let output = "";
  for (const character of value) {
    const escaped = replacements[character] ?? character;
    if (output.length + escaped.length > maxOutput - 1) return `${output}…`;
    output += escaped;
  }
  return output;
}

function formatTelegramText(value: string, maxOutput: number): string {
  return escapeLimited(value, maxOutput)
    .replace(/```(?:[\w.+-]+)?\n([\s\S]*?)```/g, "<pre>$1</pre>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

function safeDetail(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(token, "[redacted]").replace(/https:\/\/api\.telegram\.org\/bot[^\s/]+/gi, "Telegram Bot API").slice(0, 240);
}

function phaseName(phase: TurnPhase): string {
  const names: Record<TurnPhase, string> = {
    idle: "Ready",
    sending: "Sending",
    uploading: "Uploading attachments",
    thinking: "Thinking",
    responding: "Responding",
    tool: "Using tools",
    "waiting-approval": "Waiting for approval",
    updating: "Updating harness",
    "cleaning-update": "Cleaning old versions",
    "downloading-update": "Downloading update",
    cancelling: "Stopping",
    "waiting-login": "Waiting for ChatGPT login",
    error: "Error",
  };
  return names[phase];
}

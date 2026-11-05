import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { HarnessEvents } from "../events.js";
import type { ApprovalRequest, HarnessEvent, TurnPhase } from "../types.js";
import type { TelegramConfig } from "../config.js";
import type { TelegramSessionChoice } from "./sessions.js";
import { TelegramDelivery } from "./delivery.js";
import { panelTitle, renderTelegramKeyboard, type TelegramPanel, type TelegramPrompt } from "./ui.js";

const API = "https://api.telegram.org/bot";
const MAX_MESSAGE = 4096;
const MAX_PROMPT = 3500;
const EDIT_INTERVAL_MS = 950;
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
  selectedSession(): TelegramSessionChoice;
  listSessions(): Promise<TelegramSessionChoice[]>;
  chooseSession(id: string): Promise<TelegramSessionChoice>;
  resetSession(): void;
  createSession(folder: string): Promise<TelegramSessionChoice>;
  folderList(): Promise<string[]>;
  isRootSelected(): boolean;
  getBusy(): boolean;
  getPhase(): TurnPhase;
  submit(text: string): boolean;
  command(text: string): Promise<string>;
  cancel(): void;
  approve(id: string, allowed: boolean): void;
  onStatus(state: "starting" | "up" | "off" | "error", detail?: string): void;
  onPaired(profile: TelegramConfig): Promise<void>;
  saveProfile(patch: Partial<TelegramConfig>): void;
  onPairExpired(): void;
}

export class TelegramBot {
  private identity?: TelegramConfig;
  private readonly pairingWords?: readonly string[];
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
  private commandInFlight = false;
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
  private sessionMenu: TelegramSessionChoice[] = [];
  private sessionPage = 0;
  private folderMenu: string[] = [];
  private currentTool = "";
  private toolQueue: string[] = [];
  private externalRequest = false;
  private delivery?: TelegramDelivery;
  private deliveryInitializing?: Promise<void>;
  private panel: TelegramPanel = "home";
  private awaitingInput?: TelegramPrompt;
  private confirmation?: string;
  private folderPage = 0;
  private modelOptions: string[] = [];
  private effortOptions: string[] = [];
  private swarmCount = 3;

  constructor(token: string, identity: TelegramConfig | undefined, pairingWords: readonly string[] | undefined, private readonly callbacks: TelegramBotCallbacks) {
    this.token = token;
    this.identity = identity?.enabled ? identity : undefined;
    this.pairingWords = pairingWords;
    this.pairExpiresAt = pairingWords ? Date.now() + 10 * 60_000 : undefined;
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
          { command: "sessions", description: "Select any saved chat" },
          { command: "switch", description: "Switch to a saved session by ID" },
          { command: "folders", description: "Show saved project folders" },
          { command: "new", description: "Start a chat bound to a project folder" },
          { command: "stop", description: "Stop the selected task" },
          { command: "session", description: "Open, rename or inspect a chat" },
          { command: "update", description: "Manage harness updates" },
          { command: "swarm", description: "Control subagents" },
          { command: "goal", description: "Manage a harness goal" },
          { command: "model", description: "Select ChatGPT model" },
          { command: "effort", description: "Select thinking effort" },
        ]
      : [{ command: "pair", description: "Pair this private chat with the local harness" }];
    await this.api("setMyCommands", { commands });
    this.running = true;
    if (this.identity) await this.ensureDelivery();
    this.callbacks.onStatus("up", response.username ? `@${response.username}` : response.first_name);
    if (this.identity) {
      if (this.identity.selectedSessionId) {
        try { await this.callbacks.chooseSession(this.identity.selectedSessionId); }
        catch { this.callbacks.resetSession(); this.callbacks.saveProfile({ selectedSessionId: "" }); }
      }
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
    await this.delivery?.stop();
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
    const commandMatch = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text);
    if (commandMatch?.[2] && commandMatch[2].toLowerCase() !== this.botUsername.toLowerCase()) return;
    const command = commandMatch?.[1]?.toLowerCase();
    const argument = commandMatch?.[3]?.trim() ?? "";
    if (this.awaitingInput) {
      if (text === "/cancel") {
        this.awaitingInput = undefined;
        this.lastNotice = "Ввод отменён.";
        this.queueDashboard();
      } else {
        const pending = this.awaitingInput;
        await this.acceptPrompt(pending, text, message, updateId);
      }
      return;
    }
    if (command === "btw") {
      void this.runSideQuestion("/btw" + (argument ? " " + argument : ""));
      return;
    }
    if (this.requestActive || this.commandInFlight) {
      if (command === "stop" || command === "cancel") {
        this.callbacks.cancel();
        this.lastNotice = "Stop requested. Installation and some system commands cannot be interrupted.";
      } else {
        this.lastNotice = "The current Telegram request is still running. Use /stop before switching sessions or submitting another command.";
      }
      this.queueDashboard();
      return;
    }
    await this.startMessageDashboard();
    if (command) {
      switch (command) {
        case "start":
          this.panel = "home";
          this.lastNotice = "Добро пожаловать! Управляй harness кнопками ниже или отправь задачу текстом.";
          this.queueDashboard();
          return;
        case "help":
        case "status":
          void this.runHarnessCommand("/" + command + (argument ? " " + argument : ""));
          return;
        case "sessions":
          await this.loadSessionMenu();
          return;
        case "switch":
          if (!argument) { await this.loadSessionMenu(); return; }
          await this.selectSession(argument);
          return;
        case "folders":
          this.panel = "folders";
          this.folderPage = 0;
          this.folderMenu = await this.callbacks.folderList();
          this.sessionMenu = [];
          this.lastNotice = this.folderMenu.length ? "Choose a folder below to create a new chat, or use /new <absolute path>." : "No folders found. Use /new <absolute path>.";
          this.queueDashboard();
          return;
        case "session": {
          if (!argument || argument.toLowerCase() === "list") { await this.loadSessionMenu(); return; }
          if (/^new(?:\s|$)/i.test(argument)) {
            const folder = argument.replace(/^new\s*/i, "").trim() || this.callbacks.selectedSession().workspace;
            await this.createSession(folder);
            return;
          }
          const open = /^open\s+([a-f0-9-]+)$/i.exec(argument);
          if (open) { await this.selectSession(open[1]!); return; }
          if (/^(?:rename|info|job)(?:\s|$)/i.test(argument)) {
            void this.runHarnessCommand("/session " + argument);
            return;
          }
          await this.selectSession(argument);
          return;
        }
        case "clear":
          await this.createSession(this.callbacks.selectedSession().workspace);
          return;
        case "new":
        case "folder": {
          let folder = argument || this.callbacks.selectedSession().workspace;
          if (command === "folder" && /^create\s+/i.test(argument)) folder = "--create " + argument.replace(/^create\s+/i, "");
          await this.createSession(folder);
          return;
        }
        case "stop":
        case "cancel":
          this.callbacks.cancel();
          this.lastNotice = "Stop requested for the selected task or side question.";
          this.queueDashboard();
          return;
        default:
          void this.runHarnessCommand("/" + command + (argument ? " " + argument : ""));
          return;
      }
    }
    await this.submitTaskMessage(text);
  }

  private async submitTaskMessage(text: string): Promise<void> {
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
    this.externalRequest = !this.callbacks.isRootSelected();
    this.requestPrompt = text;
    this.currentTool = "";
    this.toolQueue = [];
    this.answer = "";
    this.lastNotice = "Task sent to the harness.";
    this.phase = "Sending";
    if (!this.callbacks.submit(text)) {
      this.requestActive = false;
      this.lastNotice = "The harness is busy. Use /stop or wait for the current task to finish.";
    }
    this.queueDashboard();
  }

  /** Persist complete replies before sending them through Telegram. */
  private async ensureDelivery(): Promise<void> {
    if (!this.identity || this.delivery) return;
    if (this.deliveryInitializing) return this.deliveryInitializing;
    this.deliveryInitializing = (async () => {
      const identity = this.identity!;
      const delivery = new TelegramDelivery(identity.ownerChatId, async (text) => {
        await this.api("sendMessage", {
          chat_id: identity.ownerChatId,
          text,
          disable_web_page_preview: true,
        });
      }, (error) => this.callbacks.onStatus("error", "Full-message delivery will retry: " + safeDetail(error, this.token)));
      await delivery.initialize();
      this.delivery = delivery;
    })();
    try { await this.deliveryInitializing; } finally { this.deliveryInitializing = undefined; }
  }

  private async queueFullMessage(id: string, text: string): Promise<void> {
    if (!this.identity || !text) return;
    await this.ensureDelivery();
    await this.delivery?.enqueue(id, text.replaceAll(this.token, "[redacted]"));
  }

  /** /btw is delivered separately so it cannot overwrite the active task card. */
  private async runSideQuestion(command: string): Promise<void> {
    if (command.length > MAX_PROMPT || command.includes(this.token)) return;
    try {
      const answer = await this.callbacks.command(command);
      await this.queueFullMessage("side:" + randomUUID(), answer);
    } catch (error) {
      await this.queueFullMessage("side-error:" + randomUUID(), "Side question failed: " + safeDetail(error, this.token)).catch(() => undefined);
    }
  }

  /** Execute the real command rather than sending it as a model prompt. */
  private async runHarnessCommand(text: string): Promise<void> {
    if (this.requestActive || this.callbacks.getBusy()) {
      this.lastNotice = "A task is still running. Use /stop first, or retry the command when it is idle.";
      this.queueDashboard();
      return;
    }
    if (text.includes(this.token)) {
      this.lastNotice = "Bot tokens must never be submitted in a Telegram command.";
      this.queueDashboard();
      return;
    }
    this.requestActive = true;
    this.commandInFlight = true;
    this.externalRequest = !this.callbacks.isRootSelected();
    this.requestPrompt = text;
    this.answer = "";
    this.phase = "Running command";
    this.queueDashboard();
    try {
      const response = (await this.callbacks.command(text)).replaceAll(this.token, "[redacted]");
      if (response.length > 1200 && this.identity) {
        this.answer = response.slice(0, 900) + "\n\n📨 Полный ответ отправляется отдельными сообщениями.";
        await this.queueFullMessage("command:" + randomUUID(), response);
      } else {
        this.answer = response;
      }
      this.phase = "Completed";
      const selected = this.callbacks.selectedSession();
      if (this.identity && this.identity.selectedSessionId !== selected.id) {
        this.identity.selectedSessionId = selected.id;
        this.callbacks.saveProfile({ selectedSessionId: selected.id });
      }
    } catch (error) {
      this.answer = "Command failed: " + safeDetail(error, this.token);
      this.phase = "Error";
    } finally {
      this.requestActive = false;
      this.commandInFlight = false;
      this.queueDashboard();
    }
  }

  private async startMessageDashboard(): Promise<void> {
    // A fresh card for EACH owner message; only this new card is edited while tools run.
    this.requestPrompt = "";
    this.answer = "";
    this.currentTool = "";
    this.toolQueue = [];
    this.phase = "Ready";
    this.dashboardMessageId = 0;
    this.lastRendered = "";
    this.lastKeyboard = "";
    this.lastEditAt = 0;
    this.callbacks.saveProfile({ dashboardMessageId: 0 });
    await this.updateDashboard(true);
  }

  private async loadSessionMenu(): Promise<void> {
    this.sessionMenu = await this.callbacks.listSessions();
    this.panel = "sessions";
    this.folderMenu = [];
    this.sessionPage = 0;
    this.lastNotice = this.sessionMenu.length ? `Saved chats: ${this.sessionMenu.length}. Select one below; its project folder is preserved.` : "No saved chats found.";
    this.queueDashboard();
  }

  private async selectSession(id: string): Promise<void> {
    try {
      const choice = await this.callbacks.chooseSession(id);
      this.callbacks.saveProfile({ selectedSessionId: choice.id });
      this.lastNotice = `Selected: ${choice.title.slice(0, 70)} · ${choice.workspace.slice(0, 120)}`;
      this.requestPrompt = "";
      this.answer = "";
      this.currentTool = "";
      this.toolQueue = [];
      this.sessionMenu = [];
      this.folderMenu = [];
      this.panel = "home";
    } catch (error) {
      this.lastNotice = `Cannot select chat: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.queueDashboard();
  }

  private async createSession(folder: string): Promise<void> {
    try {
      const choice = await this.callbacks.createSession(folder);
      this.callbacks.saveProfile({ selectedSessionId: choice.id });
      this.lastNotice = `New chat created in ${choice.workspace.slice(0, 120)}`;
      this.requestPrompt = "";
      this.answer = "";
      this.sessionMenu = [];
      this.folderMenu = [];
      this.panel = "home";
    } catch (error) {
      this.lastNotice = `Cannot create chat: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.queueDashboard();
  }

  /** Events from a non-foreground workspace runner must not pollute the main session. */
  onExternalSessionEvent(event: HarnessEvent): void {
    if ((this.requestActive && this.externalRequest) || event.type === "approval" || event.type === "approval-resolved") this.processAgentEvent(event);
  }

  private async tryPair(message: TelegramMessage, text: string, updateId: number): Promise<void> {
    const command = /^\/pair(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(text);
    const candidate = (command ? command[1] ?? "" : text).trim().toLowerCase().replace(/\s+/g, " ");
    if (!this.pairingWords || !this.pairExpiresAt || Date.now() > this.pairExpiresAt || !/^[a-z]+(?: [a-z]+){2}$/.test(candidate)) return;
    const attempts = (this.pairFailures.get(message.from!.id) ?? 0) + 1;
    if (attempts > 5 || this.pairTotalFailures >= 20) return;
    this.pairFailures.set(message.from!.id, attempts);
    this.pairTotalFailures += 1;
    if (candidate !== this.pairingWords.join(" ")) return;
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
    await this.ensureDelivery();
    this.lastNotice = `Private chat paired to Telegram user ID ${profile.ownerUserId}. Only this account can control the harness.`;
    await this.updateDashboard(true);
  }

  /** Telegram buttons that require a user-supplied path or instruction. */
  private async promptFor(kind: TelegramPrompt): Promise<void> {
    const hints: Record<TelegramPrompt, string> = {
      task: "Напиши задачу для выбранного проекта.",
      folder: "Пришли абсолютный путь к существующей папке (например C:\\Projects\\App).",
      "create-folder": "Пришли абсолютный путь новой папки, которую нужно создать.",
      goal: "Опиши долгосрочную цель агента.",
      rename: "Введи новое название текущей сессии.",
      swarm: `Опиши задачу для ${this.swarmCount} субагентов выбранного проекта.`,
      command: "Введи slash-команду harness (например /mcp list).",
      btw: "Задай отдельный вопрос, не прерывая основную задачу.",
      attach: "Укажи путь к файлу или folder <путь> для каталога.",
      timer: "Напиши длительность, метку и необязательную команду: 5m проверить или 5m -- npm test.",
      job: "Введи ID процесса или stop <id>, bg <id>.",
      switch: "Введи ID сохранённой сессии.",
    };
    this.awaitingInput = kind;
    this.confirmation = undefined;
    this.lastNotice = hints[kind];
    this.queueDashboard();
    if (!this.identity) return;
    try {
      await this.api("sendMessage", {
        chat_id: this.identity.ownerChatId,
        text: "✍️ " + hints[kind] + "\n\n/cancel — отменить ввод.",
        reply_markup: { force_reply: true, input_field_placeholder: "Введи ответ…" },
      });
    } catch (error) {
      this.lastNotice = "Не удалось показать поле ввода. Отправь ответ обычным сообщением: " + safeDetail(error, this.token);
      this.queueDashboard();
    }
  }

  private async acceptPrompt(kind: TelegramPrompt, value: string, message: TelegramMessage, updateId: number): Promise<void> {
    this.awaitingInput = undefined;
    this.lastNotice = "";
    this.queueDashboard();
    try {
      switch (kind) {
        case "task":
          await this.startMessageDashboard();
          await this.submitTaskMessage(value);
          return;
        case "folder":
          await this.createSession(value);
          return;
        case "create-folder":
          await this.createSession("--create " + value);
          return;
        case "rename":
          void this.runHarnessCommand("/session rename " + value);
          return;
        case "switch":
          await this.selectSession(value);
          return;
        case "goal":
          await this.startMessageDashboard();
          void this.runHarnessCommand("/goal " + value);
          return;
        case "swarm":
          await this.startMessageDashboard();
          void this.runHarnessCommand("/swarm start " + this.swarmCount + " " + value);
          return;
        case "command":
          if (!value.startsWith("/")) throw new Error("Команда должна начинаться с /.");
          await this.onMessage({ ...message, text: value }, updateId);
          return;
        case "btw":
          void this.runSideQuestion("/btw " + value);
          return;
        case "attach":
          void this.runHarnessCommand("/attach " + value);
          return;
        case "timer":
          void this.runHarnessCommand("/timer " + value);
          return;
        case "job":
          void this.runHarnessCommand("/job " + value);
          return;
      }
    } catch (error) {
      this.lastNotice = "Ошибка ввода: " + safeDetail(error, this.token);
      this.queueDashboard();
    }
  }

  private async loadPickerChoices(kind: "model" | "effort"): Promise<void> {
    if (this.requestActive || this.commandInFlight || this.callbacks.getBusy()) {
      this.lastNotice = "Дождись завершения текущей задачи, чтобы загрузить настройки модели.";
      this.queueDashboard();
      return;
    }
    try {
      const output = await this.callbacks.command("/" + kind);
      const choices = output.split(/\\r?\\n/).map((line) => /^\\s*\\d+\\.\\s+(.+)\\s*$/.exec(line)?.[1]?.trim()).filter((item): item is string => Boolean(item));
      if (kind === "model") this.modelOptions = choices;
      else this.effortOptions = choices;
      this.lastNotice = choices.length ? `Доступно вариантов: ${choices.length}. Выбери кнопкой ниже.` : output.slice(0, 300);
    } catch (error) {
      this.lastNotice = "Не удалось загрузить варианты: " + safeDetail(error, this.token);
    }
    this.queueDashboard();
  }

  private async handleUiCallback(data: string): Promise<boolean> {
    if (data === "refresh") { this.lastNotice = "Панель обновлена."; return true; }
    if (data === "input:cancel") { this.awaitingInput = undefined; this.lastNotice = "Ввод отменён."; return true; }
    if (data === "confirm:no") { this.confirmation = undefined; this.lastNotice = "Действие отменено."; return true; }
    if (data === "confirm:yes") {
      const command = this.confirmation;
      this.confirmation = undefined;
      if (!command) return true;
      if (command === "/stop") this.callbacks.cancel();
      else void this.runHarnessCommand(command);
      return true;
    }
    if (data.startsWith("nav:")) {
      const panel = data.slice(4);
      const valid: TelegramPanel[] = ["home", "sessions", "folders", "actions", "models", "effort", "swarm", "jobs", "updates", "tools", "settings"];
      if (!valid.includes(panel as TelegramPanel)) return true;
      this.panel = panel as TelegramPanel;
      if (panel === "sessions") await this.loadSessionMenu();
      else if (panel === "folders") {
        this.folderMenu = await this.callbacks.folderList();
        this.folderPage = 0;
      } else if (panel === "models" && !this.modelOptions.length) await this.loadPickerChoices("model");
      else if (panel === "effort" && !this.effortOptions.length) await this.loadPickerChoices("effort");
      return true;
    }
    if (data.startsWith("ask:")) {
      const kind = data.slice(4) as TelegramPrompt;
      const valid: TelegramPrompt[] = ["task", "folder", "create-folder", "goal", "rename", "swarm", "command", "btw", "attach", "timer", "job", "switch"];
      if (valid.includes(kind)) await this.promptFor(kind);
      return true;
    }
    if (data.startsWith("load:")) {
      const kind = data.slice(5);
      if (kind === "model" || kind === "effort") await this.loadPickerChoices(kind);
      return true;
    }
    if (/^swarm:[1-5]$/.test(data)) {
      this.swarmCount = Number(data.slice(6));
      await this.promptFor("swarm");
      return true;
    }
    if (data.startsWith("pick:")) {
      const match = /^pick:(model|effort):(\\d+)$/.exec(data);
      if (!match) return true;
      const options = match[1] === "model" ? this.modelOptions : this.effortOptions;
      const selected = options[Number(match[2])];
      if (!selected) { this.lastNotice = "Список устарел. Обнови варианты."; return true; }
      void this.runHarnessCommand("/" + match[1] + " " + selected);
      return true;
    }
    if (data === "new:current") {
      await this.createSession(this.callbacks.selectedSession().workspace);
      return true;
    }
    if (/^fp:\\d+$/.test(data)) {
      const last = Math.max(0, Math.ceil(this.folderMenu.length / 5) - 1);
      this.folderPage = Math.min(last, Number(data.slice(3)));
      return true;
    }
    if (data.startsWith("cmd:")) {
      const key = data.slice(4);
      if (key === "stop") {
        this.callbacks.cancel();
        this.lastNotice = "Отправлен запрос остановки.";
        return true;
      }
      const commands: Record<string, string> = {
        status: "/status", "session-info": "/session info",
        "goal-status": "/goal status", "goal-resume": "/goal resume",
        "goal-pause": "/goal pause", "goal-cancel": "/goal cancel",
        compact: "/compact", "swarm-status": "/swarm status",
        "swarm-results": "/swarm results", "swarm-history": "/swarm history", "swarm-stop": "/swarm stop all",
        jobs: "/jobs", timers: "/timers", attachments: "/attachments",
        agents: "/agents", skills: "/skills", "mcp-list": "/mcp list",
        context: "/context", doctor: "/doctor", tools: "/tools",
        "update-check": "/update check", "update-latest": "/update latest",
        "update-apply": "/update apply", "update-rollback": "/update rollback",
        "channel-stable": "/update settings channel stable",
        "channel-pre": "/update settings channel pre-release",
        "update-settings": "/update settings", "update-log": "/update log",
        "approval-ask": "/approval ask", "approval-never": "/approval never",
        "model-default": "/model default", "effort-default": "/effort default",
      };
      const command = commands[key];
      if (!command) return true;
      if (new Set(["update-apply", "update-rollback", "approval-never", "goal-cancel", "swarm-stop", "compact"]).has(key)) {
        this.confirmation = command;
        this.lastNotice = "Подтверди действие кнопкой.";
      } else void this.runHarnessCommand(command);
      return true;
    }
    return false;
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
    } else if (data === "sessions") {
      await this.loadSessionMenu();
    } else if (/^sp:\d+$/.test(data)) {
      this.sessionPage = Math.max(0, Number(data.slice(3)));
      this.queueDashboard();
    } else if (data.startsWith("ss:")) {
      await this.selectSession(data.slice(3));
    } else if (data === "folders") {
      this.folderMenu = await this.callbacks.folderList();
      this.sessionMenu = [];
      this.lastNotice = "Choose a folder to create a new chat.";
    } else if (/^fo:\d+$/.test(data)) {
      const folder = this.folderMenu[Number(data.slice(3))];
      if (folder) await this.createSession(folder);
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
    if (!this.identity || (this.requestActive && this.externalRequest)) return;
    this.processAgentEvent(event);
  }

  private processAgentEvent(event: HarnessEvent): void {
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
      case "assistant-done":
        if (!this.requestActive || event.channel !== "telegram") return;
        this.phase = event.type === "assistant-done" && event.error ? "Error" : "Responding";
        this.answer = event.text;
        if (event.type === "assistant-done" && event.text.trim()) {
          void this.queueFullMessage("assistant:" + event.id, event.text).catch((error: unknown) => {
            this.lastNotice = "Ответ не удалось сохранить для отправки: " + safeDetail(error, this.token);
            this.queueDashboard();
          });
        }
        this.queueDashboard();
        break;
      case "tool-start":
        if (this.requestActive) {
          const tool = `⚙️ ${event.call.name} · running`;
          if (!this.currentTool || this.lastRendered.includes(escapeLimited(this.currentTool, 180))) this.currentTool = tool;
          else this.toolQueue.push(tool);
          if (this.toolQueue.length > 120) this.toolQueue.shift();
        } else this.phase = `Local · using ${event.call.name}`;
        this.queueDashboard();
        break;
      case "tool-end":
        if (this.requestActive && this.currentTool.includes(event.call.name)) {
          this.currentTool = `${event.call.status === "ok" ? "✅" : event.call.status === "denied" ? "⛔" : "⚠️"} ${event.call.name} · ${event.call.status}`;
        }
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
    if (text === this.lastRendered && keyboardKey === this.lastKeyboard) {
      if (this.toolQueue.length) {
        this.currentTool = this.toolQueue.shift()!;
        this.queueDashboard();
      }
      return;
    }
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
    if (this.toolQueue.length) {
      this.currentTool = this.toolQueue.shift()!;
      this.queueDashboard();
    } else if (revision !== this.editRevision) this.queueDashboard();
  }

  private renderDashboard(): string {
    const selected = this.callbacks.selectedSession();
    const mode = this.confirmation ? "ПОДТВЕРЖДЕНИЕ" : this.awaitingInput ? "ОЖИДАНИЕ ВВОДА" : panelTitle(this.panel);
    const lines = [
      "✨ <b>CHATGPT WEB CODER</b>  <code>TELEGRAM</code>",
      `<b>${escapeLimited(mode, 70)}</b>`,
      "━━━━━━━━━━━━━━━━━━",
      `📁 <code>${escapeLimited(selected.workspace, 300)}</code>`,
      `💬 ${escapeLimited(selected.title, 90)}  ·  <code>${selected.id.slice(0, 8)}</code>`,
      "",
      `${this.requestActive ? "🟡" : this.phase === "Completed" ? "🟢" : this.phase === "Error" ? "🔴" : "🔵"} <b>${escapeLimited(this.phase, 90)}</b>`,
    ];
    if (this.confirmation) lines.push("", "⚠️ <b>Подтверди действие:</b>", escapeLimited(this.confirmation, 380));
    if (this.awaitingInput) lines.push("", "✍️ Ответь на запрос следующим сообщением или нажми «Отменить ввод».");
    if (this.requestPrompt) lines.push("", "<b>Запрос</b>", `<blockquote>${formatTelegramText(this.requestPrompt.replaceAll(this.token, "[redacted]"), 350)}</blockquote>`);
    if (this.currentTool) lines.push("", `⚙️ ${escapeLimited(this.currentTool, 180)}`);
    if (this.answer) lines.push("", "<b>Последний результат</b>", `<blockquote>${formatTelegramText(this.answer.replaceAll(this.token, "[redacted]"), 900)}</blockquote>`);
    if (this.delivery?.pendingCount) lines.push("", `📨 В очереди доставки: ${this.delivery.pendingCount} частей. Повторные попытки автоматические.`);
    if (this.pendingApprovals.size) {
      const approval = this.pendingApprovals.values().next().value;
      if (approval) lines.push("", "🔐 <b>Нужно разрешение</b>", `<blockquote>${escapeLimited(approval.summary, 350)}</blockquote>`);
    }
    if (this.lastNotice) lines.push("", `ℹ️ ${escapeLimited(this.lastNotice, 230)}`);
    const result = lines.join("\n");
    return result.length <= MAX_MESSAGE ? result : [
      "✨ <b>CHATGPT WEB CODER</b>",
      `📁 <code>${escapeLimited(selected.workspace, 150)}</code>`,
      `<b>${escapeLimited(this.phase, 70)}</b>`,
      this.lastNotice ? escapeLimited(this.lastNotice, 150) : "",
    ].filter(Boolean).join("\n");
  }

  private renderKeyboard(): TelegramKeyboard {
    return renderTelegramKeyboard({
      panel: this.panel,
      sessionMenu: this.sessionMenu,
      sessionPage: this.sessionPage,
      folderMenu: this.folderMenu,
      folderPage: this.folderPage,
      modelOptions: this.modelOptions,
      effortOptions: this.effortOptions,
      awaiting: this.awaitingInput,
      pendingApproval: this.pendingApprovals.values().next().value,
      confirmation: this.confirmation,
      selectedId: this.callbacks.selectedSession().id,
      swarmCount: this.swarmCount,
      pendingReplies: this.delivery?.pendingCount ?? 0,
    });
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

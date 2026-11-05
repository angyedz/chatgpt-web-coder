import type { ApprovalRequest } from "../types.js";
import type { TelegramSessionChoice } from "./sessions.js";

export type TelegramPanel = "home" | "sessions" | "folders" | "actions" | "models" | "effort" | "swarm" | "jobs" | "updates" | "tools" | "settings";
export type TelegramPrompt = "task" | "folder" | "create-folder" | "goal" | "rename" | "swarm" | "command" | "btw" | "attach" | "timer" | "job" | "switch";
export interface TelegramButton { text: string; callback_data: string }
export interface TelegramKeyboard { inline_keyboard: TelegramButton[][] }

export interface TelegramUiState {
  panel: TelegramPanel;
  sessionMenu: TelegramSessionChoice[];
  sessionPage: number;
  folderMenu: string[];
  folderPage: number;
  modelOptions: string[];
  effortOptions: string[];
  awaiting?: TelegramPrompt;
  pendingApproval?: ApprovalRequest;
  confirmation?: string;
  selectedId: string;
  swarmCount: number;
  pendingReplies: number;
}

const button = (text: string, action: string): TelegramButton => ({ text, callback_data: action });
const nav = (title: string, panel: TelegramPanel): TelegramButton => button(title, "nav:" + panel);
const back = () => [nav("⌂ Главное меню", "home")];
const page = (number: number, max: number, prefix: string) => [
  button("◀️", prefix + ":" + Math.max(0, number - 1)),
  button(`${number + 1} / ${max}`, prefix + ":" + number),
  button("▶️", prefix + ":" + Math.min(max - 1, number + 1)),
];

/** Telegram callback_data is limited to 64 bytes. All actions use short keys. */
export function renderTelegramKeyboard(state: TelegramUiState): TelegramKeyboard {
  const rows: TelegramButton[][] = [];
  if (state.confirmation) {
    rows.push([button("✅ Подтвердить", "confirm:yes"), button("✖️ Отмена", "confirm:no")]);
  } else if (state.awaiting) {
    rows.push([button("✖️ Отменить ввод", "input:cancel")]);
  } else {
    switch (state.panel) {
      case "home":
        rows.push([nav("🎯 Задачи", "actions"), nav("💬 Сессии", "sessions")]);
        rows.push([nav("🤖 Модель", "models"), nav("🧠 Мышление", "effort")]);
        rows.push([nav("🚀 Субагенты", "swarm"), nav("🛠 Инструменты", "tools")]);
        rows.push([nav("📦 Обновления", "updates"), nav("⚙️ Настройки", "settings")]);
        rows.push([button("✍️ Написать задачу", "ask:task"), button("🛑 Стоп", "cmd:stop")]);
        rows.push([button("↻ Обновить", "refresh")]);
        break;
      case "sessions": {
        const count = Math.max(1, Math.ceil(state.sessionMenu.length / 5));
        const current = Math.min(state.sessionPage, count - 1);
        for (const item of state.sessionMenu.slice(current * 5, current * 5 + 5)) {
          const name = item.title.replace(/\s+/g, " ").slice(0, 23);
          const folder = item.workspace.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 12) ?? "?";
          rows.push([button(`${item.id === state.selectedId ? "🟢" : "⚪"} ${name} · ${folder}`, "ss:" + item.id)]);
        }
        if (count > 1) rows.push(page(current, count, "sp"));
        rows.push([button("➕ Текущая папка", "new:current"), nav("📁 Другие папки", "folders")]);
        rows.push([button("📂 Указать путь", "ask:folder"), button("📁 Создать папку", "ask:create-folder")]);
        rows.push([button("✏️ Название", "ask:rename"), button("ℹ️ Информация", "cmd:session-info")]);
        rows.push([button("🔎 По ID", "ask:switch")]);
        rows.push(back());
        break;
      }
      case "folders": {
        const count = Math.max(1, Math.ceil(state.folderMenu.length / 5));
        const current = Math.min(state.folderPage, count - 1);
        state.folderMenu.slice(current * 5, current * 5 + 5).forEach((folder, index) => {
          const base = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
          rows.push([button("📁 " + base.slice(0, 38), "fo:" + (current * 5 + index))]);
        });
        if (count > 1) rows.push(page(current, count, "fp"));
        rows.push([button("📂 Существующая", "ask:folder"), button("➕ Новая папка", "ask:create-folder")]);
        rows.push([nav("↩️ К сессиям", "sessions"), ...back()]);
        break;
      }
      case "actions":
        rows.push([button("✍️ Задача", "ask:task"), button("🎯 Новая цель", "ask:goal")]);
        rows.push([button("▶️ Продолжить цель", "cmd:goal-resume"), button("📊 Статус цели", "cmd:goal-status")]);
        rows.push([button("⏸ Пауза", "cmd:goal-pause"), button("❌ Отменить цель", "cmd:goal-cancel")]);
        rows.push([button("💭 Вопрос /btw", "ask:btw"), button("🧹 Компактировать", "cmd:compact")]);
        rows.push(back());
        break;
      case "models":
      case "effort": {
        const kind = state.panel === "models" ? "model" : "effort";
        const choices = kind === "model" ? state.modelOptions : state.effortOptions;
        choices.slice(0, 16).forEach((choice, index) => rows.push([button(`${index + 1}. ${choice.slice(0, 43)}`, `pick:${kind}:${index}`)]));
        rows.push([button("↻ Загрузить список", "load:" + kind), button("◌ По умолчанию", "cmd:" + kind + "-default")]);
        rows.push([nav(kind === "model" ? "🧠 Мышление" : "🤖 Модель", kind === "model" ? "effort" : "models")]);
        rows.push(back());
        break;
      }
      case "swarm":
        rows.push([button("➊ 1 агент", "swarm:1"), button("➋ 2 агента", "swarm:2"), button("➌ 3 агента", "swarm:3")]);
        rows.push([button("➍ 4 агента", "swarm:4"), button("➎ 5 агентов", "swarm:5")]);
        rows.push([button("📊 Статус", "cmd:swarm-status"), button("📋 Результаты", "cmd:swarm-results")]);
        rows.push([button("🗃 История", "cmd:swarm-history"), button("🛑 Стоп всех", "cmd:swarm-stop")]);
        rows.push(back());
        break;
      case "jobs":
        rows.push([button("📟 Процессы", "cmd:jobs"), button("⏰ Таймеры", "cmd:timers")]);
        rows.push([button("➕ Таймер", "ask:timer"), button("🔎 Процесс по ID", "ask:job")]);
        rows.push([nav("↩️ Инструменты", "tools"), ...back()]);
        break;
      case "tools":
        rows.push([nav("🧰 Процессы / таймеры", "jobs"), button("📎 Прикрепить", "ask:attach")]);
        rows.push([button("📂 Вложения", "cmd:attachments"), button("📄 AGENTS.md", "cmd:agents")]);
        rows.push([button("✨ Skills", "cmd:skills"), button("🛠 MCP", "cmd:mcp-list")]);
        rows.push([button("📊 Контекст", "cmd:context"), button("🩺 Диагностика", "cmd:doctor")]);
        rows.push([button("⌨️ Команда вручную", "ask:command")]);
        rows.push(back());
        break;
      case "updates":
        rows.push([button("🔍 Проверить", "cmd:update-check"), button("⬇️ Скачать", "cmd:update-latest")]);
        rows.push([button("✅ Применить", "cmd:update-apply"), button("↩️ Откат", "cmd:update-rollback")]);
        rows.push([button("🟢 Stable", "cmd:channel-stable"), button("🧪 Pre-release", "cmd:channel-pre")]);
        rows.push([button("⚙️ Настройки", "cmd:update-settings"), button("📋 Журнал", "cmd:update-log")]);
        rows.push(back());
        break;
      case "settings":
        rows.push([nav("🤖 Модели", "models"), nav("🧠 Мышление", "effort")]);
        rows.push([button("🔐 Подтверждать", "cmd:approval-ask"), button("⚠️ YOLO", "cmd:approval-never")]);
        rows.push([button("ℹ️ Harness", "cmd:status"), button("📦 Обновления", "nav:updates")]);
        rows.push([button("⌨️ Любая команда", "ask:command")]);
        rows.push(back());
        break;
    }
  }
  if (state.pendingApproval) {
    const id = state.pendingApproval.id;
    // Each Bot API callback payload must fit 64 bytes.
    if (Buffer.byteLength("approval:" + id + ":yes") <= 64) rows.push([
      button("✅ Разрешить", "approval:" + id + ":yes"),
      button("❌ Отклонить", "approval:" + id + ":no"),
    ]);
  }
  return { inline_keyboard: rows };
}

export function panelTitle(panel: TelegramPanel): string {
  const labels: Record<TelegramPanel, string> = {
    home: "ГЛАВНОЕ МЕНЮ", sessions: "СЕССИИ", folders: "ПАПКИ", actions: "ЗАДАЧИ",
    models: "МОДЕЛЬ", effort: "МЫШЛЕНИЕ", swarm: "СУБАГЕНТЫ",
    jobs: "ПРОЦЕССЫ И ТАЙМЕРЫ", updates: "ОБНОВЛЕНИЯ",
    tools: "ИНСТРУМЕНТЫ", settings: "НАСТРОЙКИ",
  };
  return labels[panel];
}

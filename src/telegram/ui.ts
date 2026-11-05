import type { ApprovalRequest } from "../types.js";
import { createHash } from "node:crypto";
import type { TelegramSessionChoice } from "./sessions.js";

export type TelegramPanel = "home" | "sessions" | "folders" | "actions" | "models" | "effort" | "swarm" | "agent" | "jobs" | "updates" | "tools" | "settings";
export type TelegramPrompt = "task" | "folder" | "create-folder" | "goal" | "rename" | "swarm" | "command" | "btw" | "attach" | "timer" | "job" | "switch" | "agent-message";
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
  selectedAgent?: number;
  optionPage?: number;
  pendingReplies: number;
}

const button = (text: string, action: string): TelegramButton => ({ text, callback_data: action });
const nav = (title: string, panel: TelegramPanel): TelegramButton => button(title, "nav:" + panel);
const back = () => [nav("⌂ Main menu", "home")];
const page = (number: number, max: number, prefix: string) => [
  button("◀️", prefix + ":" + Math.max(0, number - 1)),
  button(`${number + 1} / ${max}`, prefix + ":" + number),
  button("▶️", prefix + ":" + Math.min(max - 1, number + 1)),
];

/** Use a stable short token when an approval ID cannot fit Telegram's 64-byte callbacks. */
export function approvalCallbackId(id: string): string {
  return Buffer.byteLength("approval:" + id + ":yes") <= 64
    ? id
    : "h-" + createHash("sha256").update(id).digest("hex").slice(0, 20);
}

/** Telegram callback_data is limited to 64 bytes. All actions use short keys. */
export function renderTelegramKeyboard(state: TelegramUiState): TelegramKeyboard {
  const rows: TelegramButton[][] = [];
  if (state.confirmation) {
    rows.push([button("✅ Confirm", "confirm:yes"), button("✖️ Cancel", "confirm:no")]);
  } else if (state.awaiting) {
    rows.push([button("✖️ Cancel input", "input:cancel")]);
  } else {
    switch (state.panel) {
      case "home":
        rows.push([nav("🎯 Tasks", "actions"), nav("💬 Sessions", "sessions")]);
        rows.push([nav("🤖 Model", "models"), nav("🧠 Effort", "effort")]);
        rows.push([nav("🚀 Subagents", "swarm"), nav("🛠 Tools", "tools")]);
        rows.push([nav("📦 Updates", "updates"), nav("⚙️ Settings", "settings")]);
        rows.push([button("✍️ Send a task", "ask:task"), button("🛑 Stop", "cmd:stop")]);
        rows.push([button("↻ Refresh", "refresh")]);
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
        rows.push([button("➕ Current folder", "new:current"), nav("📁 Other folders", "folders")]);
        rows.push([button("📂 Enter a path", "ask:folder"), button("📁 Create folder", "ask:create-folder")]);
        rows.push([button("✏️ Rename", "ask:rename"), button("ℹ️ Details", "cmd:session-info")]);
        rows.push([button("🔎 By ID", "ask:switch")]);
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
        rows.push([button("📂 Existing folder", "ask:folder"), button("➕ New folder", "ask:create-folder")]);
        rows.push([nav("↩️ Sessions", "sessions"), ...back()]);
        break;
      }
      case "actions":
        rows.push([button("✍️ Task", "ask:task"), button("🎯 New goal", "ask:goal")]);
        rows.push([button("▶️ Resume goal", "cmd:goal-resume"), button("📊 Goal status", "cmd:goal-status")]);
        rows.push([button("⏸ Pause", "cmd:goal-pause"), button("❌ Cancel goal", "cmd:goal-cancel")]);
        rows.push([button("💭 Ask /btw", "ask:btw"), button("🧹 Compact context", "cmd:compact")]);
        rows.push(back());
        break;
      case "models":
      case "effort": {
        const kind = state.panel === "models" ? "model" : "effort";
        const choices = kind === "model" ? state.modelOptions : state.effortOptions;
        const pages = Math.max(1, Math.ceil(choices.length / 8));
        const activePage = Math.min(state.optionPage ?? 0, pages - 1);
        choices.slice(activePage * 8, activePage * 8 + 8).forEach((choice, index) => {
          const absolute = activePage * 8 + index;
          rows.push([button(`${absolute + 1}. ${choice.slice(0, 43)}`, `pick:${kind}:${absolute}`)]);
        });
        if (pages > 1) rows.push(page(activePage, pages, kind === "model" ? "mp" : "ep"));
        rows.push([button("↻ Load options", "load:" + kind), button("◌ Use default", "cmd:" + kind + "-default")]);
        rows.push([nav(kind === "model" ? "🧠 Effort" : "🤖 Model", kind === "model" ? "effort" : "models")]);
        rows.push(back());
        break;
      }
      case "swarm":
        rows.push([button("➊ 1 agent", "swarm:1"), button("➋ 2 agents", "swarm:2"), button("➌ 3 agents", "swarm:3")]);
        rows.push([button("➍ 4 agents", "swarm:4"), button("➎ 5 agents", "swarm:5")]);
        rows.push([button("📊 Status", "cmd:swarm-status"), button("📋 Results", "cmd:swarm-results")]);
        rows.push([button("🗃 History", "cmd:swarm-history"), button("🛑 Stop all", "cmd:swarm-stop")]);
        rows.push([button("Agent 1", "agent:1"), button("Agent 2", "agent:2"), button("Agent 3", "agent:3")]);
        rows.push([button("Agent 4", "agent:4"), button("Agent 5", "agent:5")]);
        rows.push(back());
        break;
      case "agent":
        rows.push([button("🔍 Inspect", "cmd:agent-inspect"), button("💬 Chat history", "cmd:agent-chat")]);
        rows.push([button("✍️ Send a message", "ask:agent-message"), button("🪟 Open tab", "cmd:agent-open")]);
        rows.push([button("🛑 Stop agent", "cmd:agent-stop")]);
        rows.push([nav("↩️ Subagents", "swarm"), ...back()]);
        break;
      case "jobs":
        rows.push([button("📟 Jobs", "cmd:jobs"), button("⏰ Timers", "cmd:timers")]);
        rows.push([button("➕ Add timer", "ask:timer"), button("🔎 Job by ID", "ask:job")]);
        rows.push([nav("↩️ Tools", "tools"), ...back()]);
        break;
      case "tools":
        rows.push([nav("🧰 Jobs / timers", "jobs"), button("📎 Attach", "ask:attach")]);
        rows.push([button("📂 Attachments", "cmd:attachments"), button("📄 AGENTS.md", "cmd:agents")]);
        rows.push([button("✨ Skills", "cmd:skills"), button("🛠 MCP", "cmd:mcp-list")]);
        rows.push([button("📊 Context", "cmd:context"), button("🩺 Diagnostics", "cmd:doctor")]);
        rows.push([button("⌨️ Run a command", "ask:command")]);
        rows.push(back());
        break;
      case "updates":
        rows.push([button("🔍 Check", "cmd:update-check"), button("⬇️ Download", "cmd:update-latest")]);
        rows.push([button("✅ Apply", "cmd:update-apply"), button("↩️ Roll back", "cmd:update-rollback")]);
        rows.push([button("🟢 Stable", "cmd:channel-stable"), button("🧪 Pre-release", "cmd:channel-pre")]);
        rows.push([button("⚙️ Settings", "cmd:update-settings"), button("📋 Release log", "cmd:update-log")]);
        rows.push(back());
        break;
      case "settings":
        rows.push([nav("🤖 Models", "models"), nav("🧠 Effort", "effort")]);
        rows.push([button("🔐 Ask before actions", "cmd:approval-ask"), button("⚠️ YOLO", "cmd:approval-never")]);
        rows.push([button("ℹ️ Harness", "cmd:status"), button("📦 Updates", "nav:updates")]);
        rows.push([button("⌨️ Run any command", "ask:command")]);
        rows.push(back());
        break;
    }
  }
  if (state.pendingApproval) {
    const id = approvalCallbackId(state.pendingApproval.id);
    rows.push([
      button("✅ Approve", "approval:" + id + ":yes"),
      button("❌ Deny", "approval:" + id + ":no"),
    ]);
  }
  return { inline_keyboard: rows };
}

export function panelTitle(panel: TelegramPanel): string {
  const labels: Record<TelegramPanel, string> = {
    home: "MAIN MENU", sessions: "SESSIONS", folders: "FOLDERS", actions: "TASKS",
    models: "MODEL", effort: "REASONING EFFORT", swarm: "SUBAGENTS", agent: "AGENT CONTROLS",
    jobs: "JOBS AND TIMERS", updates: "UPDATES",
    tools: "TOOLS", settings: "SETTINGS",
  };
  return labels[panel];
}

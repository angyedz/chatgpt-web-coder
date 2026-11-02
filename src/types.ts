export type Role = "user" | "assistant" | "system";
import type { SavedSession } from "./runtime/sessions.js";
import type { Goal } from "./runtime/goals.js";
import type { Attachment } from "./runtime/attachments.js";

export type ConnectionState = "off" | "starting" | "up" | "error";

export type TurnPhase =
  | "idle"
  | "sending"
  | "uploading"
  | "thinking"
  | "responding"
  | "tool"
  | "waiting-approval"
  | "updating"
  | "cleaning-update"
  | "downloading-update"
  | "cancelling"
  | "waiting-login"
  | "error";

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
  order?: number;
  streaming?: boolean;
  interrupted?: boolean;
  channel?: "btw" | "telegram";
}

export type ToolStatus = "running" | "ok" | "error" | "denied";

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  startedAt: number;
  order?: number;
  endedAt?: number;
  output?: string;
  error?: string;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  summary: string;
  args: unknown;
  createdAt: number;
}

export interface SessionInfo {
  url?: string;
  temporary: boolean;
  model?: string;
  effort?: string;
}

export type TelegramSetupState =
  | { stage: "token"; error?: string }
  | { stage: "pairing"; botUsername: string; words: string[] };

export interface SubagentSnapshot {
  id: string;
  role: string;
  objective: string;
  status: "preparing" | "running" | "done" | "failed" | "stopped";
  workspace: string;
  branch: string;
  toolCount: number;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
}

export type HarnessEvent =
  | { type: "user-message"; id: string; text: string; channel?: "btw" | "telegram" }
  | { type: "telegram-setup"; state?: TelegramSetupState }
  | { type: "subagents"; agents: SubagentSnapshot[] }
  | { type: "system-message"; id: string; text: string }
  | { type: "assistant-start"; id: string; channel?: "btw" | "telegram" }
  | { type: "assistant-delta"; id: string; text: string; channel?: "btw" | "telegram" }
  | { type: "assistant-done"; id: string; text: string; error?: string; channel?: "btw" | "telegram" }
  | { type: "tool-start"; call: ToolCallView }
  | { type: "tool-end"; call: ToolCallView }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "goal"; goal?: Goal }
  | { type: "attachments"; attachments: Attachment[] }
  | {
      type: "status";
      key: "browser" | "mcp" | "tunnel" | "searxng" | "telegram";
      state: ConnectionState;
      detail?: string;
    }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "update-selection"; pending?: { kind: "download" | "local" | "rollback"; version: string } }
  | { type: "mcp-refresh"; reminder?: { name: string; result: "changed" | "unknown" } }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string; allowed: boolean }
  | { type: "turn-start"; turnId: string }
  | { type: "turn-end"; turnId: string; ok: boolean }
  | { type: "phase"; phase: TurnPhase }
  | { type: "session"; session: SessionInfo }
  | { type: "session-view"; session: SavedSession }
  | { type: "tokens"; input?: number; output?: number }
  | { type: "clear" }
  | { type: "quit" };

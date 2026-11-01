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
  channel?: "btw";
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

export type HarnessEvent =
  | { type: "user-message"; id: string; text: string; channel?: "btw" }
  | { type: "system-message"; id: string; text: string }
  | { type: "assistant-start"; id: string; channel?: "btw" }
  | { type: "assistant-delta"; id: string; text: string; channel?: "btw" }
  | { type: "assistant-done"; id: string; text: string; error?: string; channel?: "btw" }
  | { type: "tool-start"; call: ToolCallView }
  | { type: "tool-end"; call: ToolCallView }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "goal"; goal?: Goal }
  | { type: "attachments"; attachments: Attachment[] }
  | {
      type: "status";
      key: "browser" | "mcp" | "tunnel" | "searxng";
      state: ConnectionState;
      detail?: string;
    }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "update-selection"; pending?: { kind: "download" | "local" | "rollback"; version: string } }
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

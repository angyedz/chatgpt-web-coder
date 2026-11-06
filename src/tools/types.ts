import type { z } from "zod";
import type { HarnessConfig } from "../config.js";
import type { HarnessEvents } from "../events.js";
import type { ApprovalManager } from "./approvals.js";
import type { ExecSessionManager } from "./exec.js";
import type { PlanStore } from "./plan.js";
import type { TimerManager } from "../runtime/timers.js";
import type { BackgroundTaskManager } from "../runtime/tasks.js";
import type { ExternalMcpManager } from "../mcp/client.js";
import type { GoalStore } from "../runtime/goals.js";
import type { AttachmentStore } from "../runtime/attachments.js";
import type { SubagentSnapshot, SwarmOrchestratorSnapshot } from "../types.js";

export interface SubagentControl {
  readonly snapshots: SubagentSnapshot[];
  readonly orchestration?: SwarmOrchestratorSnapshot;
  start(count: number, objective: string): Promise<void>;
  sendMessage(id: string, message: string): Promise<string>;
  waitFor(timeoutMs?: number): Promise<SubagentSnapshot[]>;
  stop(id?: string): void;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type ToolContent = TextContent | ImageContent;

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolContext {
  workspace: string;
  config: HarnessConfig;
  events: HarnessEvents;
  approvals: ApprovalManager;
  plan: PlanStore;
  goal: GoalStore;
  attachments: AttachmentStore;
  exec: ExecSessionManager;
  timers: TimerManager;
  tasks: BackgroundTaskManager;
  externalMcp: ExternalMcpManager;
  subagents?: SubagentControl;
  /** Present only in an active dedicated swarm coordinator turn. */
  reviewSwarm?: (input: Record<string, unknown>) => string;
  /** Restrict a dedicated coordinator to inspection and coordination tools. */
  allowedTools?: readonly string[];
  browser?: {
    listInteractiveControls(): Promise<string>;
    interactWithControl(controlId: string, action: "click" | "fill" | "select" | "check" | "uncheck", value?: string): Promise<string>;
  };
  turnSignal?: AbortSignal;
  turnId: string;
  approvalScope?: string;
  beforeToolStart?: () => Promise<void>;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function errorText(value: string): ToolResult {
  return { content: [{ type: "text", text: value }], isError: true };
}

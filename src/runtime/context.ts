import type { HarnessConfig } from "../config.js";
import { HarnessEvents } from "../events.js";
import { ApprovalManager } from "../tools/approvals.js";
import { ExecSessionManager } from "../tools/exec.js";
import { PlanStore } from "../tools/plan.js";
import { TimerManager } from "./timers.js";
import { BackgroundTaskManager } from "./tasks.js";
import type { ToolContext } from "../tools/types.js";
import { ExternalMcpManager } from "../mcp/client.js";
import { GoalStore } from "./goals.js";

export interface Runtime {
  events: HarnessEvents;
  approvals: ApprovalManager;
  plan: PlanStore;
  goal: GoalStore;
  exec: ExecSessionManager;
  timers: TimerManager;
  tasks: BackgroundTaskManager;
  externalMcp: ExternalMcpManager;
  context: ToolContext;
}

export function createRuntime(
  config: HarnessConfig,
  events = new HarnessEvents(),
  turnId = "standalone",
): Runtime {
  const approvals = new ApprovalManager(events, config.approvalMode);
  const plan = new PlanStore(events);
  const goal = new GoalStore(events);
  const exec = new ExecSessionManager(config.maxOutputChars, events);
  const timers = new TimerManager(events);
  const tasks = new BackgroundTaskManager(events);
  const externalMcp = new ExternalMcpManager(config);
  const context: ToolContext = {
    workspace: config.workspace,
    config,
    events,
    approvals,
    plan,
    goal,
    exec,
    timers,
    tasks,
    externalMcp,
    turnId,
  };
  return { events, approvals, plan, goal, exec, timers, tasks, externalMcp, context };
}

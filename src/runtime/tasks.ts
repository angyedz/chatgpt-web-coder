import type { HarnessEvents } from "../events.js";
import type { ToolResult } from "../tools/types.js";
import { newId } from "../utils/ids.js";

export interface BackgroundTask {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  result?: ToolResult;
  turnId?: string;
}

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly events: HarnessEvents) {}

  start(name: string, turnId: string, action: (id: string, signal: AbortSignal) => Promise<ToolResult>): BackgroundTask {
    const controller = new AbortController();
    const task: BackgroundTask = { id: newId("task"), name, status: "running", startedAt: Date.now(), turnId };
    this.tasks.set(task.id, task);
    this.controllers.set(task.id, controller);
    void Promise.resolve().then(() => action(task.id, controller.signal)).then(
      (result) => {
        if (task.status === "cancelled") return;
        task.result = result;
        task.status = controller.signal.aborted ? "cancelled" : result.isError ? "failed" : "completed";
      },
      (error: unknown) => {
        if (task.status === "cancelled") return;
        task.result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        task.status = controller.signal.aborted ? "cancelled" : "failed";
      },
    ).then(() => {
      if (task.status !== "cancelled") {
        task.endedAt = Date.now();
        this.events.emit({ type: "notice", level: task.status === "failed" ? "error" : "info", text: `Background task ${task.id} ${task.status}: ${task.name}` });
      }
      this.controllers.delete(task.id);
    });
    return { ...task };
  }

  cancelTurn(turnId: string): string[] {
    const cancelled: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.turnId !== turnId || task.status !== "running") continue;
      this.controllers.get(task.id)?.abort();
      task.status = "cancelled";
      task.endedAt = Date.now();
      cancelled.push(task.id);
    }
    if (cancelled.length) this.events.emit({ type: "notice", level: "info", text: `Stopped ${cancelled.length} background tool task${cancelled.length === 1 ? "" : "s"} from the cancelled turn.` });
    return cancelled;
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  get(id: string): BackgroundTask | undefined {
    const task = this.tasks.get(id);
    return task && { ...task };
  }
}

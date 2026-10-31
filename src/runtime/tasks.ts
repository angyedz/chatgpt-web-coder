import type { HarnessEvents } from "../events.js";
import type { ToolResult } from "../tools/types.js";
import { newId } from "../utils/ids.js";

export interface BackgroundTask {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
  result?: ToolResult;
}

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  constructor(private readonly events: HarnessEvents) {}

  start(name: string, action: (id: string) => Promise<ToolResult>): BackgroundTask {
    const task: BackgroundTask = { id: newId("task"), name, status: "running", startedAt: Date.now() };
    this.tasks.set(task.id, task);
    void Promise.resolve().then(() => action(task.id)).then(
      (result) => { task.result = result; task.status = result.isError ? "failed" : "completed"; },
      (error: unknown) => { task.result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; task.status = "failed"; },
    ).then(() => {
      task.endedAt = Date.now();
      this.events.emit({ type: "notice", level: task.status === "failed" ? "error" : "info", text: `Background task ${task.id} ${task.status}: ${task.name}` });
    });
    return { ...task };
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  get(id: string): BackgroundTask | undefined {
    const task = this.tasks.get(id);
    return task && { ...task };
  }
}

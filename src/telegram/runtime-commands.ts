import type { Runtime } from "../runtime/context.js";
import type { SessionStore } from "../runtime/sessions.js";
import { describeTimer, scheduleTimer } from "../runtime/schedule.js";
import { parseDuration } from "../runtime/timers.js";

export async function captureRemoteRuntime(runtime: Runtime, store: SessionStore): Promise<void> {
  store.setRuntime([
    ...runtime.exec.list().map((job) => ({
      id: job.id, kind: "process" as const,
      status: job.running ? "running" : job.timedOut ? "timed out" : `exit ${job.exitCode ?? "unknown"}`,
      description: job.command, output: job.tail,
    })),
    ...runtime.tasks.list().map((task) => ({
      id: task.id, kind: "task" as const,
      status: task.status, description: task.name,
      output: task.result?.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n"),
    })),
  ], runtime.timers.list());
  await store.flush();
}

/** Use the selected project's long-lived runtime, never the root harness. */
export async function runRemoteRuntimeCommand(name: string, argument: string, runtime: Runtime, store: SessionStore): Promise<string> {
  if (name === "timer" || name === "timers") {
    const [action = "", ...parts] = argument.trim().split(/\s+/);
    if (!action || action.toLowerCase() === "list") {
      const timers = runtime.timers.list();
      return timers.length ? "Timers in selected project:\n" + timers.map(describeTimer).join("\n") : "No active timers in selected project.";
    }
    if (action.toLowerCase() === "cancel") {
      const id = parts[0] ?? "";
      const cancelled = runtime.timers.cancel(id);
      await captureRemoteRuntime(runtime, store);
      return cancelled ? `Cancelled timer ${id}.` : `Timer ${id || "(missing ID)"} is not pending.`;
    }
    const duration = parseDuration(action);
    if (!duration) throw new Error("Usage: /timer 5m [label] · /timer 30s -- <command> · /timer cancel <id> · /timers");
    const remainder = argument.slice(argument.indexOf(action) + action.length).trim();
    const separator = /(?:^|\s)--(?:\s+|$)/.exec(remainder);
    const command = separator ? remainder.slice(separator.index + separator[0].length).trim() : "";
    if (separator && !command) throw new Error("Add a command after --.");
    const label = (separator ? remainder.slice(0, separator.index).trim() : remainder) || command || "Timer";
    const timer = scheduleTimer(runtime.context, duration, label, command || undefined);
    await captureRemoteRuntime(runtime, store);
    return `Timer created for selected project: ${describeTimer(timer)}. Runs while harness is open.`;
  }

  if (name === "jobs") {
    const processes = runtime.exec.list();
    const tasks = runtime.tasks.list();
    const lines = [
      ...processes.map((job) => `${job.id} · ${job.running ? "running" : `exit ${job.exitCode}`} · ${job.background ? "background" : "foreground"} · ${job.command.slice(0, 90)}`),
      ...tasks.map((task) => `${task.id} · ${task.status} · ${task.name}`),
    ];
    await captureRemoteRuntime(runtime, store);
    return lines.length ? "Jobs in selected project:\n" + lines.join("\n") : "No jobs in selected project.";
  }

  if (name === "job") {
    const [action = "", id = ""] = argument.trim().split(/\s+/);
    if (action === "stop") {
      const stopped = await runtime.exec.kill(id);
      await captureRemoteRuntime(runtime, store);
      return stopped ? `Stopped process ${id}.` : `Process ${id || "(missing ID)"} is not running.`;
    }
    if (action === "bg") {
      const moved = runtime.exec.background(id);
      await captureRemoteRuntime(runtime, store);
      return moved ? `Moved process ${id} to the background.` : `Process ${id || "(missing ID)"} is not running.`;
    }
    const process = runtime.exec.inspect(action);
    if (process) return `${process.id} · ${process.running ? "running" : "finished"}\n${process.command}\n\n${process.tail || "(no output)"}`;
    const task = runtime.tasks.get(action);
    if (task) return `${task.id} · ${task.status} · ${task.name}\n\n${task.result?.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n") || "(waiting for result)"}`;
    throw new Error("Usage: /job <id> · /job stop <process-id> · /job bg <process-id>");
  }

  throw new Error("Unsupported runtime command: " + name);
}

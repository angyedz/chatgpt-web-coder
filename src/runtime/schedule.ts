import type { ToolContext } from "../tools/types.js";
import type { TimerInfo } from "./timers.js";

export function scheduleTimer(ctx: ToolContext, durationMs: number, label: string, command?: string): TimerInfo {
  return ctx.timers.schedule(durationMs, label, command ? async () => {
    const result = await ctx.exec.run(command, { workdir: ctx.workspace, background: true, yieldTimeMs: 250 });
    const status = result.running ? `running as ${result.sessionId}` : `finished (exit ${result.exitCode ?? "?"}, session ${result.sessionId})`;
    ctx.events.emit({ type: "notice", level: result.exitCode && result.exitCode !== 0 ? "error" : "info", text: `Scheduled command ${status}. Use /jobs or /job ${result.sessionId} to inspect.` });
  } : undefined, command);
}

export function describeTimer(timer: TimerInfo): string {
  const remaining = Math.max(0, Math.ceil((timer.dueAt - Date.now()) / 1000));
  return `${timer.id} · ${remaining}s · ${timer.label}${timer.command ? ` · command: ${timer.command}` : ""}`;
}

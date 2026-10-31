import type { HarnessEvents } from "../events.js";
import { newId } from "../utils/ids.js";

export interface TimerInfo {
  id: string;
  label: string;
  dueAt: number;
  command?: string;
}

const MAX_DELAY = 2_147_000_000;

export class TimerManager {
  private readonly timers = new Map<string, { info: TimerInfo; handle: NodeJS.Timeout }>();
  constructor(private readonly events: HarnessEvents) {}

  schedule(durationMs: number, label: string, callback?: () => Promise<void>, command?: string): TimerInfo {
    if (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > MAX_DELAY) {
      throw new Error("Timer duration must be between 100 ms and 24 days.");
    }
    const info: TimerInfo = { id: newId("timer"), label: label.trim() || "Timer", dueAt: Date.now() + durationMs, command };
    const handle = setTimeout(() => {
      if (!this.timers.delete(info.id)) return;
      this.events.emit({ type: "notice", level: "warn", text: `Timer finished: ${info.label} (${info.id})` });
      if (callback) void callback().catch((error: unknown) => {
        this.events.emit({ type: "notice", level: "error", text: `Timer ${info.id} failed: ${error instanceof Error ? error.message : String(error)}` });
      });
    }, durationMs);
    handle.unref();
    this.timers.set(info.id, { info, handle });
    return info;
  }

  list(): TimerInfo[] {
    return [...this.timers.values()].map(({ info }) => ({ ...info })).sort((a, b) => a.dueAt - b.dueAt);
  }

  cancel(id: string): boolean {
    const timer = this.timers.get(id);
    if (!timer) return false;
    clearTimeout(timer.handle);
    this.timers.delete(id);
    return true;
  }

  dispose(): void {
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }
}

export function parseDuration(value: string): number | undefined {
  const input = value.trim().toLowerCase().replace(/\s+/g, "");
  const part = /(\d+(?:\.\d+)?)(ms|мс|s|с|m|м|h|ч|d|д)/gy;
  const units: Record<string, number> = { ms: 1, мс: 1, s: 1000, с: 1000, m: 60_000, м: 60_000, h: 3_600_000, ч: 3_600_000, d: 86_400_000, д: 86_400_000 };
  let position = 0;
  let total = 0;
  while (position < input.length) {
    part.lastIndex = position;
    const match = part.exec(input);
    if (!match) return undefined;
    total += Number(match[1]) * units[match[2]!]!;
    position = part.lastIndex;
  }
  return total >= 100 && total <= MAX_DELAY ? Math.round(total) : undefined;
}

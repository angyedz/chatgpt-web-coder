import type { HarnessEvents } from "../events.js";

export interface Goal {
  objective: string;
  status: "active" | "paused" | "blocked" | "complete" | "cancelled";
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

export class GoalStore {
  private goal?: Goal;
  constructor(private readonly events: HarnessEvents) {}
  get current(): Goal | undefined { return this.goal ? { ...this.goal } : undefined; }
  restore(goal?: Goal): void { this.goal = goal ? { ...goal } : undefined; this.emit(); }
  start(objective: string): void {
    const now = Date.now();
    this.goal = { objective, status: "active", createdAt: now, updatedAt: now };
    this.emit();
  }
  setStatus(status: Goal["status"], detail?: string): void {
    if (!this.goal) throw new Error("There is no goal in this session.");
    this.goal = { ...this.goal, status, detail, updatedAt: Date.now() };
    this.emit();
  }
  private emit(): void { this.events.emit({ type: "goal", goal: this.current }); }
}

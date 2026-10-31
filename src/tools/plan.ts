import type { HarnessEvents } from "../events.js";
import type { PlanStep } from "../types.js";

export class PlanStore {
  private steps: PlanStep[] = [];

  constructor(private readonly events: HarnessEvents) {}

  get current(): PlanStep[] {
    return this.steps;
  }

  update(steps: PlanStep[]): void {
    this.steps = steps;
    this.events.emit({ type: "plan", steps: this.steps });
  }

  clear(): void {
    this.update([]);
  }
}

import type { ApprovalMode } from "../config.js";
import type { HarnessEvents } from "../events.js";
import type { ApprovalRequest } from "../types.js";
import { newId } from "../utils/ids.js";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (allowed: boolean, reason?: string) => void;
  timer: NodeJS.Timeout;
  scope?: string;
}

export interface ApprovalOutcome {
  allowed: boolean;
  reason?: string;
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly events: HarnessEvents,
    public mode: ApprovalMode,
  ) {}

  get pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  async request(
    tool: string,
    args: unknown,
    summary: string,
    timeoutMs = 70_000,
    scope?: string,
  ): Promise<ApprovalOutcome> {
    if (this.mode === "never") {
      return { allowed: true };
    }

    const id = newId("approval");
    const request: ApprovalRequest = {
      id,
      tool,
      args,
      summary,
      createdAt: Date.now(),
    };

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.events.emit({ type: "approval-resolved", id, allowed: false });
        this.events.emit({
          type: "notice",
          level: "warn",
          text: `Approval for ${tool} timed out.`,
        });
        resolve({ allowed: false, reason: "Approval timed out" });
      }, timeoutMs);

      this.pending.set(id, {
        request,
        scope,
        timer,
        resolve: (allowed, reason) => resolve({ allowed, reason }),
      });
      this.events.emit({ type: "approval", request });
    });
  }

  respond(id: string, allowed: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(allowed);
    this.events.emit({ type: "approval-resolved", id, allowed });
  }

  allowAll(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, true);
  }

  denyAll(reason = "Session is closing"): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false, reason);
      this.events.emit({ type: "approval-resolved", id, allowed: false });
    }
    this.pending.clear();
  }

  denyForeground(reason = "Turn cancelled"): void {
    for (const [id, entry] of this.pending) {
      if (entry.scope) continue;
      clearTimeout(entry.timer);
      entry.resolve(false, reason);
      this.events.emit({ type: "approval-resolved", id, allowed: false });
      this.pending.delete(id);
    }
  }

  denyScope(scope: string, reason = "Turn cancelled"): void {
    for (const [id, entry] of this.pending) {
      if (entry.scope !== scope) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(false, reason);
      this.events.emit({ type: "approval-resolved", id, allowed: false });
    }
  }
}

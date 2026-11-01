import type { ApprovalMode } from "../config.js";
import type { HarnessEvents } from "../events.js";
import type { ApprovalRequest } from "../types.js";
import { newId } from "../utils/ids.js";
import { createHash } from "node:crypto";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (allowed: boolean, reason?: string) => void;
  timer: NodeJS.Timeout;
  scope?: string;
  actionKey: string;
}

export interface ApprovalOutcome {
  allowed: boolean;
  reason?: string;
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly deniedActions = new Set<string>();

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
    force = false,
  ): Promise<ApprovalOutcome> {
    const normalized = args && typeof args === "object" && !Array.isArray(args) ? { ...args as Record<string, unknown> } : args;
    if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) delete (normalized as Record<string, unknown>).require_approval;
    const actionKey = createHash("sha256").update(JSON.stringify([tool, normalized])).digest("hex");
    if (this.mode === "never" && !force && !this.deniedActions.has(actionKey)) {
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
        actionKey,
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
    if (allowed) this.deniedActions.delete(entry.actionKey);
    else {
      this.deniedActions.add(entry.actionKey);
      if (this.deniedActions.size > 500) this.deniedActions.delete(this.deniedActions.values().next().value!);
    }
    entry.resolve(allowed);
    this.events.emit({ type: "approval-resolved", id, allowed });
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
}

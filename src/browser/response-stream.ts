import type { HarnessEvents } from "../events.js";

// A web response may contain several assistant messages separated by tools.
// ChatGPT can render the next message either as a new node or by extending the
// previous node, so retain a snapshot at each tool boundary.
export class ResponseStream {
  private sequence = 0;
  private source = "";
  private anchor = "";
  private waitingAfterTool = false;
  private id?: string;
  private current = "";
  private readonly completed: string[] = [];

  constructor(private readonly events: HarnessEvents, private readonly prefix: string) {}

  get hasCurrentSegment(): boolean {
    return Boolean(this.id && this.current);
  }

  get lastObservedText(): string {
    return this.source;
  }

  update(text: string): void {
    if (!text) return;
    if (this.waitingAfterTool) {
      if (text === this.anchor) return;
      this.waitingAfterTool = false;
    }
    this.source = text;
    let segment = this.anchor && text.startsWith(this.anchor)
      ? text.slice(this.anchor.length).trimStart()
      : text;
    // A fallback can change from a single message to the complete turn after
    // a tool. Recover the boundary from already emitted messages instead of
    // replaying the entire conversation into a new assistant message.
    if (segment === text && this.completed.length && this.completed[0]!.length >= 20 && text.startsWith(this.completed[0]!)) {
      for (let index = this.completed.length - 1; index >= 0; index -= 1) {
        const previous = this.completed[index]!;
        if (previous.length < 20) continue;
        const at = text.lastIndexOf(previous);
        if (at >= 0) {
          segment = text.slice(at + previous.length).trimStart();
          break;
        }
      }
    }
    if (!segment.trim()) return;
    if (!this.id) {
      this.id = `${this.prefix}_${this.sequence++}`;
      this.events.emit({ type: "assistant-start", id: this.id });
    }
    segment = segment.trimEnd();
    if (segment === this.current) return;
    this.current = segment;
    this.events.emit({ type: "assistant-delta", id: this.id, text: segment });
  }

  toolStarted(): void {
    this.finishSegment();
    this.anchor = this.source;
    this.waitingAfterTool = true;
  }

  finish(): void {
    this.finishSegment();
  }

  interrupt(reason: string): void {
    this.finishSegment(reason);
  }

  private finishSegment(error?: string): void {
    if (this.id) {
      this.events.emit({ type: "assistant-done", id: this.id, text: this.current, ...(error ? { error } : {}) });
      if (this.current) this.completed.push(this.current);
      this.id = undefined;
      this.current = "";
    }
  }
}

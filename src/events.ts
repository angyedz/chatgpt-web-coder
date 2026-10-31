import { EventEmitter } from "node:events";
import type { HarnessEvent } from "./types.js";

export class HarnessEvents {
  private readonly bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(50);
  }

  emit(event: HarnessEvent): void {
    this.bus.emit("event", event);
  }

  on(handler: (event: HarnessEvent) => void): () => void {
    this.bus.on("event", handler);
    return () => this.bus.off("event", handler);
  }
}

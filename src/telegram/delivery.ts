import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { harnessHome } from "../utils/paths.js";

const PART_SIZE = 3500;
const COMPLETED_IDS = 512;

interface QueuedReply {
  id: string;
  parts: string[];
  nextPart: number;
}

interface DeliveryState {
  version: 1;
  queue: QueuedReply[];
  completed: string[];
}

/** Split without changing, dropping, or duplicating any Unicode code points. */
export function splitTelegramMessage(value: string, limit = PART_SIZE): string[] {
  if (!Number.isInteger(limit) || limit < 2 || limit > 4096) throw new Error("Invalid Telegram message size.");
  if (!value) return [];
  const parts: string[] = [];
  let current = "";
  for (const character of value) {
    if (current.length + character.length > limit) {
      if (current) parts.push(current);
      current = "";
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Durable, in-order, at-least-once Telegram text delivery.
 * A successful send is checkpointed per part. A crash after the API accepts
 * a part but before the checkpoint may repeat that part, but never drops it.
 */
export class TelegramDelivery {
  private readonly file: string;
  private readonly queue: QueuedReply[] = [];
  private completed: string[] = [];
  private initialized = false;
  private starting?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private draining?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;
  private failures = 0;

  constructor(
    chatId: string,
    private readonly send: (text: string) => Promise<void>,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {
    const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 24);
    this.file = path.join(harnessHome(), "telegram", "outbox-" + hash + ".json");
  }

  get pendingCount(): number { return this.queue.reduce((sum, item) => sum + item.parts.length - item.nextPart, 0); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const saved = JSON.parse(await readFile(this.file, "utf8")) as DeliveryState;
        if (saved.version !== 1 || !Array.isArray(saved.queue) || !Array.isArray(saved.completed)) {
          throw new Error("Invalid Telegram delivery outbox.");
        }
        for (const item of saved.queue) {
          if (typeof item.id !== "string" || !Array.isArray(item.parts) ||
              !item.parts.every((part) => typeof part === "string") ||
              !Number.isInteger(item.nextPart) || item.nextPart < 0 || item.nextPart > item.parts.length) {
            throw new Error("Invalid saved Telegram delivery message.");
          }
          this.queue.push(item);
        }
        this.completed = saved.completed.filter((id): id is string => typeof id === "string").slice(-COMPLETED_IDS);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.initialized = true;
      this.wake();
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  async enqueue(id: string, text: string): Promise<void> {
    await this.initialize();
    if (this.stopped || !text || this.completed.includes(id) || this.queue.some((item) => item.id === id)) return;
    this.queue.push({ id, parts: splitTelegramMessage(text), nextPart: 0 });
    await this.checkpoint();
    this.wake();
  }

  private async checkpoint(): Promise<void> {
    const snapshot: DeliveryState = {
      version: 1,
      queue: this.queue.map((item) => ({ id: item.id, parts: [...item.parts], nextPart: item.nextPart })),
      completed: [...this.completed],
    };
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
        if (process.platform !== "win32") await chmod(temporary, 0o600);
        await rename(temporary, this.file);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    return this.writes;
  }

  private wake(): void {
    if (this.stopped || this.retryTimer || this.draining || !this.queue.length) return;
    this.draining = this.drain().catch((error: unknown) => {
      // Disk errors during a checkpoint must not create an unhandled rejection
      // or permanently strand later messages in the queue.
      const failure = error instanceof Error ? error : new Error(String(error));
      this.onError(failure);
      if (!this.stopped && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.wake();
        }, 5000);
        this.retryTimer.unref?.();
      }
    }).finally(() => {
      this.draining = undefined;
      // An enqueue may have happened as the previous drain was completing.
      if (!this.stopped && !this.retryTimer && this.queue.length) this.wake();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queue.length) {
      const item = this.queue[0]!;
      if (item.nextPart >= item.parts.length) {
        this.queue.shift();
        this.completed.push(item.id);
        this.completed = this.completed.slice(-COMPLETED_IDS);
        await this.checkpoint();
        continue;
      }
      try {
        await this.send(item.parts[item.nextPart]!);
        item.nextPart++;
        await this.checkpoint();
        this.failures = 0;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.onError(failure);
        this.failures++;
        const retryAfter = Number((error as { retryAfter?: number } | null)?.retryAfter ?? 0);
        const waitMs = Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, Math.min(60_000, 1500 * 2 ** Math.min(this.failures, 6)));
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.wake();
        }, waitMs);
        this.retryTimer.unref?.();
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.draining?.catch(() => undefined);
    await this.writes;
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { splitTelegramMessage, TelegramDelivery } from "../src/telegram/delivery.js";

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { force: true, recursive: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "tg-delivery-"));
  folders.push(home);
  vi.stubEnv("CHATGPT_CODER_HOME", home);
}

describe("Telegram reliable delivery", () => {
  it("splits long Unicode messages without losing a single character", () => {
    const original = "🛠️ Код и проверка\n" + "x<>&\"😀\n".repeat(2100) + "\nEND";
    const parts = splitTelegramMessage(original);
    expect(parts.length).toBeGreaterThan(4);
    expect(parts.every((part) => part.length <= 3500)).toBe(true);
    expect(parts.join("")).toBe(original);
  });

  it("delivers every part in order and avoids duplicate enqueue IDs", async () => {
    await tempHome();
    const delivered: string[] = [];
    const outbox = new TelegramDelivery("123", async (text) => { delivered.push(text); });
    const original = "a".repeat(8500);
    await outbox.enqueue("first", original);
    await outbox.enqueue("first", original);
    await vi.waitFor(() => expect(delivered.join("")).toBe(original));
    expect(delivered).toHaveLength(3);
    await outbox.stop();
  });

  it("retains unsent data on disk and resumes after process restart", async () => {
    await tempHome();
    const failing = new TelegramDelivery("456", async () => { throw new Error("network down"); });
    const original = "b".repeat(8000);
    await failing.enqueue("reply", original);
    await vi.waitFor(() => expect(failing.pendingCount).toBe(3));
    await failing.stop();

    const parts: string[] = [];
    const restored = new TelegramDelivery("456", async (text) => { parts.push(text); });
    await restored.initialize();
    await vi.waitFor(() => expect(parts.join("")).toBe(original));
    expect(parts).toHaveLength(3);
    await restored.stop();
  });

  it("never replays an already acknowledged response after restart", async () => {
    await tempHome();
    const first = new TelegramDelivery("789", async () => undefined);
    await first.enqueue("reply-1", "Delivered");
    await vi.waitFor(() => expect(first.pendingCount).toBe(0));
    await first.stop();
    const send = vi.fn(async () => undefined);
    const second = new TelegramDelivery("789", send);
    await second.initialize();
    await second.enqueue("reply-1", "Delivered");
    await second.stop();
    expect(send).not.toHaveBeenCalled();
  });
});

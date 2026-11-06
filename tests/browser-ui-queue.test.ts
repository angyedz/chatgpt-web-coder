import type { BrowserContext } from "playwright";
import { expect, it } from "vitest";
import { withBrowserUi } from "../src/browser/ui-queue.js";

it("serializes preparation across a profile and cancels a queued tab without running its actions", async () => {
  const context = {} as BrowserContext;
  const history: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const first = withBrowserUi(context, async () => { history.push("first"); await hold; history.push("released"); });
  const controller = new AbortController();
  const cancelled = withBrowserUi(context, async () => { history.push("must not run"); }, controller.signal).catch((error: unknown) => error);
  const third = withBrowserUi(context, async () => { history.push("third"); });
  controller.abort();
  expect(await cancelled).toBeInstanceOf(DOMException);
  expect(history).toEqual(["first"]);
  release();
  await Promise.all([first, third]);
  expect(history).toEqual(["first", "released", "third"]);
});

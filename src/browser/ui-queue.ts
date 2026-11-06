import type { BrowserContext } from "playwright";

// Tabs share profile settings and browser input focus. Serialize preparation,
// then release the queue before waiting for any model response or MCP call.
const queues = new WeakMap<BrowserContext, Promise<void>>();

export async function withBrowserUi<T>(context: BrowserContext, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const previous = queues.get(context) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  queues.set(context, tail);
  let onAbort: (() => void) | undefined;
  try {
    if (signal) {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      await Promise.race([previous, aborted]);
    } else await previous;
    if (onAbort) signal!.removeEventListener("abort", onAbort);
    signal?.throwIfAborted();
    return await action();
  } finally {
    if (onAbort) signal!.removeEventListener("abort", onAbort);
    release();
    if (queues.get(context) === tail) void tail.then(() => { if (queues.get(context) === tail) queues.delete(context); });
  }
}

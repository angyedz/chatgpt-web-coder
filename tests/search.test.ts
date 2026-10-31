import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { searxngSearch } from "../src/tools/search.js";

const servers: Server[] = [];

async function startSearxng(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("searxngSearch", () => {
  it("formats results, answers and suggestions", async () => {
    const requests: URL[] = [];
    const url = await startSearxng((req, res) => {
      requests.push(new URL(req.url ?? "/", "http://127.0.0.1"));
      json(res, {
        query: "typescript",
        answers: ["TypeScript is a typed superset of JavaScript."],
        results: [
          { title: "TypeScript", url: "https://www.typescriptlang.org/", content: " Official   site " },
          { title: "", url: "https://example.com/a", content: "" },
        ],
        suggestions: ["typescript tutorial", "typescript 6"],
      });
    });

    const output = await searxngSearch(
      { url, categories: "general", language: "auto" },
      "typescript",
      5,
    );

    expect(requests[0]?.searchParams.get("q")).toBe("typescript");
    expect(requests[0]?.searchParams.get("format")).toBe("json");
    expect(requests[0]?.searchParams.get("categories")).toBe("general");
    expect(requests[0]?.searchParams.has("language")).toBe(false);

    expect(output).toContain('Search results for "typescript"');
    expect(output).toContain("Answer: TypeScript is a typed superset of JavaScript.");
    expect(output).toContain("1. TypeScript\n   https://www.typescriptlang.org/\n   Official site");
    expect(output).toContain("2. (untitled)\n   https://example.com/a");
    expect(output).toContain("Related: typescript tutorial, typescript 6");
  });

  it("passes the configured language and caps the result count", async () => {
    let seen: URL | undefined;
    const url = await startSearxng((req, res) => {
      seen = new URL(req.url ?? "/", "http://127.0.0.1");
      json(res, {
        results: Array.from({ length: 30 }, (_, index) => ({
          title: `result ${index}`,
          url: `https://example.com/${index}`,
        })),
      });
    });

    const output = await searxngSearch({ url, categories: "news", language: "ru" }, "новости", 3);

    expect(seen?.searchParams.get("language")).toBe("ru");
    expect(seen?.searchParams.get("categories")).toBe("news");
    expect(output).toContain("3. result 2");
    expect(output).not.toContain("4. result 3");
  });

  it("reports unresponsive engines when no results came back", async () => {
    const url = await startSearxng((_req, res) => {
      json(res, {
        results: [],
        unresponsive_engines: [
          ["google", "rate limit"],
          ["bing", "timeout"],
        ],
      });
    });

    const output = await searxngSearch({ url, categories: "general", language: "auto" }, "zzz");

    expect(output).toBe('No results for "zzz". Unresponsive engines: google, bing.');
  });

  it("explains how to fix a missing JSON API", async () => {
    const url = await startSearxng((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    });

    await expect(
      searxngSearch({ url, categories: "general", language: "auto" }, "query"),
    ).rejects.toThrow(/search\.formats: \[html, json\]/);
  });

  it("surfaces the HTTP status", async () => {
    const url = await startSearxng((_req, res) => {
      json(res, { error: "forbidden" }, 403);
    });

    await expect(
      searxngSearch({ url, categories: "general", language: "auto" }, "query"),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("turns connection failures into an actionable error", async () => {
    const url = await startSearxng((_req, res) => res.end());
    const port = Number(new URL(url).port);
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    await expect(
      searxngSearch(
        { url: `http://127.0.0.1:${port}`, categories: "general", language: "auto" },
        "query",
      ),
    ).rejects.toThrow(/SearXNG is unreachable at http:\/\/127\.0\.0\.1:\d+.*Check SEARXNG_URL/);
  });
});

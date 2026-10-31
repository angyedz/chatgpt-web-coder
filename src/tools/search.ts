import type { SearxngConfig } from "../config.js";
import { truncate } from "../utils/text.js";

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

interface SearxngResponse {
  query?: string;
  results?: SearxngResult[];
  answers?: string[];
  infoboxes?: Array<{ infobox?: string; content?: string }>;
  suggestions?: string[];
  unresponsive_engines?: Array<[string, string]>;
}

export async function searxngSearch(
  config: SearxngConfig,
  query: string,
  count = 8,
): Promise<string> {
  const base = config.url.replace(/\/+$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", config.categories);
  if (config.language && config.language !== "auto") {
    url.searchParams.set("language", config.language);
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url, 15_000, {
      headers: {
        Accept: "application/json",
        "User-Agent": "chatgpt-coder/0.1",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SearXNG is unreachable at ${base}: ${detail}. Check SEARXNG_URL and that the instance is running.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `SearXNG returned HTTP ${response.status}. Check SEARXNG_URL and that the JSON API is enabled.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(
      "SearXNG did not return JSON. Enable the JSON format in settings.yml (search.formats: [html, json]).",
    );
  }

  const data = (await response.json()) as SearxngResponse;
  const results = (data.results ?? []).slice(0, Math.max(1, Math.min(count, 20)));
  const unresponsive = (data.unresponsive_engines ?? [])
    .map((entry) => entry?.[0])
    .filter((engine): engine is string => Boolean(engine));
  if (results.length === 0) {
    const detail = unresponsive.length
      ? ` Unresponsive engines: ${unresponsive.join(", ")}.`
      : "";
    return `No results for "${query}".${detail}`;
  }

  const parts: string[] = [`Search results for "${query}":`];
  for (const answer of data.answers ?? []) {
    parts.push(`\nAnswer: ${answer}`);
  }
  results.forEach((result, index) => {
    const title = result.title?.trim() || "(untitled)";
    const link = result.url?.trim() || "";
    const snippet = (result.content ?? "").replace(/\s+/g, " ").trim();
    parts.push(
      `\n${index + 1}. ${title}\n   ${link}${snippet ? `\n   ${truncate(snippet, 500)}` : ""}`,
    );
  });

  if (data.suggestions?.length) {
    parts.push(`\nRelated: ${data.suggestions.slice(0, 5).join(", ")}`);
  }

  return parts.join("\n");
}

export async function fetchWebPage(
  target: string,
  maxChars = 20_000,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`Invalid URL: ${target}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported.");
  }

  const response = await fetchWithTimeout(url, 25_000, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.8,ru;q=0.7",
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await readBody(response, 2 * 1024 * 1024);
  const body = contentType.includes("html")
    ? htmlToText(raw)
    : contentType.includes("json")
      ? prettyJson(raw)
      : raw;

  const header = `URL: ${response.url || target}\nStatus: ${response.status} ${response.statusText}\nContent-Type: ${contentType || "unknown"}\n`;
  return `${header}\n${truncate(body, Math.max(1000, Math.min(maxChars, 100_000)))}`;
}

async function fetchWithTimeout(
  url: URL,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs} ms: ${url.toString()}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text = new TextDecoder("utf-8").decode(merged);
  if (size >= maxBytes) text += "\n\n... response body truncated ...";
  return text;
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num: string) =>
      String.fromCodePoint(Number.parseInt(num, 10)),
    );
}

function prettyJson(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

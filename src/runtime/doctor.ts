import { existsSync } from "node:fs";
import type { HarnessConfig } from "../config.js";

export interface DoctorResult {
  ok: boolean;
  lines: string[];
}

export async function runDoctor(
  config: HarnessConfig,
  mcpUrl: string | undefined,
  extra: { browserOpen: boolean },
): Promise<DoctorResult> {
  const lines: string[] = [];
  let ok = true;

  const add = (status: "ok" | "warn" | "fail", text: string) => {
    lines.push(`${status === "ok" ? "✓" : status === "warn" ? "!" : "✗"} ${text}`);
    if (status === "fail") ok = false;
  };

  add("ok", `Node ${process.version}, ${process.platform}/${process.arch}`);
  add("ok", `Workspace: ${config.workspace}`);
  add(
    existsSync(config.workspace) ? "ok" : "fail",
    existsSync(config.workspace) ? "Workspace exists" : "Workspace is missing",
  );

  if (mcpUrl) {
    try {
      const response = await fetch(mcpUrl.replace(/\/mcp$/, "/healthz"), {
        signal: AbortSignal.timeout(3000),
      });
      add(
        response.ok ? "ok" : "fail",
        response.ok ? `MCP server: ${mcpUrl}` : `MCP health returned ${response.status}`,
      );
    } catch (error) {
      add("fail", `MCP server unreachable: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    add("fail", "MCP server has not started");
  }

  add(extra.browserOpen ? "ok" : "warn", extra.browserOpen ? "Browser connected" : "Browser not connected");

  add(
    config.tunnel.tunnelId ? "ok" : "warn",
    config.tunnel.tunnelId ? `Tunnel id: ${config.tunnel.tunnelId}` : "TUNNEL_ID is not set",
  );
  add(
    process.env[config.tunnel.apiKeyEnv] ? "ok" : "warn",
    process.env[config.tunnel.apiKeyEnv]
      ? `${config.tunnel.apiKeyEnv} is set`
      : `${config.tunnel.apiKeyEnv} is not set`,
  );
  add(
    existsSync(config.tunnel.binary) ? "ok" : "fail",
    existsSync(config.tunnel.binary)
      ? `tunnel-client: ${config.tunnel.binary}`
      : `tunnel-client missing: ${config.tunnel.binary} (run chatgpt-coder --install-tunnel or /connect install)`,
  );

  if (config.browser.attachConnector) {
    add(
      config.browser.connectorName ? "ok" : "fail",
      config.browser.connectorName
        ? `ChatGPT connector: "${config.browser.connectorName}" (create it with Authentication: None, Allow all actions)`
        : "browser.connectorName is empty but attachConnector is enabled",
    );
    add(
      config.browser.useTemporaryChat ? "warn" : "ok",
      config.browser.useTemporaryChat
        ? "Temporary chat is enabled; it must be Personalized for connectors to work"
        : "Using saved chats (connectors are available)",
    );
  } else {
    add("warn", "Connector attachment is disabled; ChatGPT cannot call local tools");
  }

  if (config.searxng.url) {
    try {
      const url = new URL(`${config.searxng.url.replace(/\/+$/, "")}/search`);
      url.searchParams.set("q", "ping");
      url.searchParams.set("format", "json");
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const type = response.headers.get("content-type") ?? "";
      add(
        response.ok && type.includes("json") ? "ok" : "warn",
        response.ok && type.includes("json")
          ? `SearXNG: ${config.searxng.url}`
          : `SearXNG responded ${response.status} (${type || "unknown"}); enable the JSON API`,
      );
    } catch (error) {
      add(
        "warn",
        `SearXNG unreachable: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else {
    add("warn", "SEARXNG_URL is not set (web_search will fail)");
  }

  return { ok, lines };
}

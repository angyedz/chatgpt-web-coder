import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExternalMcpServer, HarnessConfig } from "../config.js";
import { APP_VERSION } from "../runtime/version.js";
import { expandHome } from "../utils/paths.js";

function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const result = process.env[name];
    if (result === undefined) throw new Error(`MCP environment variable ${name} is not set.`);
    return result;
  });
}

export class ExternalMcpManager {
  private readonly clients = new Map<string, Client>();
  private readonly connecting = new Map<string, Promise<Client>>();
  private readonly stderr = new Map<string, string>();

  constructor(private readonly config: HarnessConfig) {}

  list(): Array<{ name: string; transport: string; state: string }> {
    return Object.entries(this.config.mcpServers).map(([name, server]) => ({
      name, transport: server.transport ?? (server.url ? "http" : "stdio"),
      state: server.disabled ? "disabled" : this.clients.has(name) ? "connected" : this.connecting.has(name) ? "connecting" : "disconnected",
    }));
  }

  logs(name: string): string {
    return this.stderr.get(name) || "(no stderr output)";
  }

  async connect(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const pending = this.connecting.get(name);
    if (pending) return pending;
    const server = Object.hasOwn(this.config.mcpServers, name) ? this.config.mcpServers[name] : undefined;
    if (!server || server.disabled) throw new Error(`MCP server ${name} is not configured or is disabled.`);
    const promise = this.open(name, server);
    this.connecting.set(name, promise);
    try { return await promise; }
    finally { if (this.connecting.get(name) === promise) this.connecting.delete(name); }
  }

  private async open(name: string, server: ExternalMcpServer): Promise<Client> {
    const client = new Client({ name: "chatgpt-coder", version: APP_VERSION });
    const kind = server.transport ?? (server.url ? "http" : "stdio");
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (kind === "stdio") {
      if (!server.command) throw new Error(`MCP server ${name} has no command.`);
      const env = { ...getDefaultEnvironment() };
      for (const [key, value] of Object.entries(server.env ?? {})) env[key] = expandEnvironment(value);
      transport = new StdioClientTransport({
        command: expandEnvironment(expandHome(server.command)),
        args: server.args?.map(expandEnvironment), env, stderr: "pipe",
        cwd: server.cwd ? path.resolve(this.config.workspace, expandHome(server.cwd)) : this.config.workspace,
      });
      this.stderr.set(name, "");
      // Keep a bounded local diagnostic log; it is not included in MCP results.
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        this.stderr.set(name, `${this.stderr.get(name) ?? ""}${chunk.toString()}`.slice(-12_000));
      });
    } else if (kind === "http") {
      if (!server.url) throw new Error(`MCP server ${name} has no URL.`);
      const url = new URL(expandEnvironment(server.url));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP URL must use HTTP or HTTPS.");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(server.headers ?? {})) headers[key] = expandEnvironment(value);
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    } else {
      throw new Error(`Unknown MCP transport for ${name}.`);
    }
    client.onclose = () => { if (this.clients.get(name) === client) this.clients.delete(name); };
    try {
      await client.connect(transport, { signal: AbortSignal.timeout(15_000) });
      this.clients.set(name, client);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name) ?? await this.connecting.get(name)?.catch(() => undefined);
    this.clients.delete(name);
    if (client) await client.close();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...new Set([...this.clients.keys(), ...this.connecting.keys()])].map((name) => this.disconnect(name)));
  }
}

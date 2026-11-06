import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpConfig } from "../config.js";
import { APP_VERSION } from "../runtime/version.js";
import { toolDefinitions, errorText } from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";
import { newId } from "../utils/ids.js";
import { safeJson, truncate } from "../utils/text.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export class McpHost {
  private httpServer?: Server;
  private readonly sessions = new Map<string, Session>();
  private readonly workerContexts = new Map<string, ToolContext>();
  private actualPort: number;
  private actualUrl = "";

  constructor(
    private readonly ctx: ToolContext,
    private readonly config: McpConfig,
  ) {
    this.actualPort = config.port;
  }

  get url(): string {
    return this.actualUrl;
  }

  get port(): number {
    return this.actualPort;
  }

  registerTurnContext(turnId: string, context: ToolContext): void {
    if (this.workerContexts.has(turnId)) throw new Error("Subagent turn ID is already registered.");
    this.workerContexts.set(turnId, context);
  }

  unregisterTurnContext(turnId: string): void {
    this.workerContexts.delete(turnId);
  }

  async start(): Promise<string> {
    if (this.httpServer) return this.actualUrl;

    this.httpServer = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
            id: null,
          }),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.port, this.config.host);
    });

    const address = this.httpServer.address();
    if (address && typeof address === "object") {
      this.actualPort = address.port;
    }
    this.actualUrl = `http://${this.config.host}:${this.actualPort}${this.config.path}`;
    this.ctx.events.emit({
      type: "status",
      key: "mcp",
      state: "up",
      detail: this.actualUrl,
    });
    return this.actualUrl;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.transport.close().catch(() => undefined);
      await session.server.close().catch(() => undefined);
    }
    this.sessions.clear();
    this.workerContexts.clear();
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
      this.httpServer = undefined;
    });
    this.ctx.events.emit({ type: "status", key: "mcp", state: "off" });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          url: this.actualUrl,
          sessions: this.sessions.size,
          tools: toolDefinitions.length,
        }),
      );
      return;
    }

    if (url.pathname === "/tools") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          toolDefinitions.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
          null,
          2,
        ),
      );
      return;
    }

    if (url.pathname !== this.config.path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", path: url.pathname }));
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const sessionId = headerValue(req.headers["mcp-session-id"]);

      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          writeRpcError(res, 404, -32001, "Session not found");
          return;
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        writeRpcError(res, 400, -32000, "Bad Request: initialization required");
        return;
      }

      const server = createMcpServer(this.ctx, (turnId) => this.workerContexts.get(turnId));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, { transport, server });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) this.sessions.delete(id);
        void server.close().catch(() => undefined);
      };
      transport.onerror = (error) => {
        this.ctx.events.emit({
          type: "notice",
          level: "warn",
          text: `MCP transport error: ${error.message}`,
        });
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = headerValue(req.headers["mcp-session-id"]);
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session) {
        writeRpcError(res, 400, -32000, "Invalid or missing session id");
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "content-type": "application/json", allow: "GET, POST, DELETE" });
    res.end(JSON.stringify({ error: "method not allowed" }));
  }
}

export function createMcpServer(ctx: ToolContext, resolveWorker?: (turnId: string) => ToolContext | undefined): McpServer {
  const server = new McpServer(
      { name: "chatgpt-coder", version: APP_VERSION },
    {
      instructions:
        "Local coding harness tools. Every tool call requires turn_id copied exactly from the active Turn in the prompt; stale calls are rejected. Use exec_command/write_stdin for terminal work, read_file/list_dir/glob/grep to inspect the workspace, apply_patch for edits, and web_search/web_fetch for the internet. Always verify results with real tool output.",
    },
  );

  for (const def of toolDefinitions) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: {
          ...def.inputSchema,
          turn_id: z.string().min(1).describe("Required current harness turn ID. Copy the exact Turn value from the active task prompt. Calls with an old or missing ID are rejected."),
        },
        annotations: def.annotations,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const callTurnId = typeof args.turn_id === "string" ? args.turn_id : "";
        const { turn_id: _turnId, ...toolArgs } = args;
        // Every ChatGPT tab is bound to its own turn, abort signal and workspace.
        const active = resolveWorker?.(callTurnId) ?? ctx;
        const callSignal = active.turnSignal;
        const validTurn = () => Boolean(callSignal && !callSignal.aborted
          && active.turnSignal === callSignal && active.turnId === callTurnId
          && (active === ctx ? !resolveWorker?.(callTurnId) : resolveWorker?.(callTurnId) === active));
        if (!callTurnId || callTurnId !== active.turnId || !callSignal || callSignal.aborted) {
          return errorText("Rejected stale tool call: no active matching harness turn.") as CallToolResult;
        }
        if (active.allowedTools && !active.allowedTools.includes(def.name)) {
          return errorText("This orchestrator turn only permits workspace inspection and its allowed MCP coordination tools. Delegate other actions to its workers.") as CallToolResult;
        }
        const callContext = { ...active, turnId: callTurnId, turnSignal: callSignal };
        await active.beforeToolStart?.().catch(() => undefined);
        if (!validTurn()) return errorText("The turn was cancelled or replaced before this tool started.") as CallToolResult;
        const call = {
          id: newId("call"),
          name: def.name,
          args: toolArgs,
          status: "running" as const,
          startedAt: Date.now(),
        };
        active.events.emit({ type: "tool-start", call });
        active.events.emit({ type: "phase", phase: "tool" });

        try {
          const result = await def.handler(toolArgs, callContext);
          const finalResult = validTurn()
            ? result
            : errorText("The harness turn was cancelled or replaced while this tool was running; do not continue or start more actions.");
          const output = finalResult.content
            .map((item) =>
              item.type === "text"
                ? item.text
                : `[image ${item.mimeType}, ${item.data.length} base64 chars]`,
            )
            .join("\n");
          active.events.emit({
            type: "tool-end",
            call: {
              ...call,
              status: finalResult.isError ? "error" : "ok",
              endedAt: Date.now(),
              output: truncate(output, 4000),
            },
          });
          return finalResult as CallToolResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          active.events.emit({
            type: "tool-end",
            call: {
              ...call,
              status: "error",
              endedAt: Date.now(),
              error: message,
            },
          });
          const failed = errorText(message);
          return failed as CallToolResult;
        }
      },
    );
  }

  return server;
}

function writeRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 10 * 1024 * 1024) {
      throw new Error("Request body exceeds 10 MiB");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON body: ${safeJson(raw.slice(0, 500), 500)}`);
  }
}

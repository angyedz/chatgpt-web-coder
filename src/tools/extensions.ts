import { z } from "zod";
import { discoverSkills, readSkill } from "../runtime/skills.js";
import { formatInstructions, projectInstructions } from "../runtime/instructions.js";
import { safeJson, truncate } from "../utils/text.js";
import { errorText, text, type ToolContent, type ToolDefinition } from "./types.js";

const serverField = z.string().min(1).describe("Configured MCP server name from mcp_list_servers.");

export const extensionTools: ToolDefinition[] = [
  {
    name: "get_project_instructions", title: "Read applicable AGENTS.md files",
    description: "Read AGENTS.md instructions from workspace ancestors down to the directory containing the given workspace path. Call before working in a directory, especially before editing files; deeper instructions apply only within their directory.",
    inputSchema: { path: z.string().optional().describe("Workspace file or directory; default '.'.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const files = await projectInstructions(ctx.workspace, typeof args.path === "string" ? args.path : ".");
      return text(files.length ? formatInstructions(files) : "No applicable AGENTS.md files.");
    },
  },
  {
    name: "list_skills", title: "List available skills",
    description: "List available local SKILL.md instructions by name and description. Use read_skill before applying a relevant or explicitly requested skill.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => text(safeJson((await discoverSkills(ctx.config)).map(({ name, description, file }) => ({ name, description, file })), ctx.config.maxOutputChars)),
  },
  {
    name: "read_skill", title: "Read a skill or its supporting file",
    description: "Read SKILL.md for a listed skill, or a supporting file within the same skill directory. Follow skill instructions unless they conflict with higher-priority or user instructions.",
    inputSchema: { name: z.string().min(1), path: z.string().optional().describe("Relative supporting file path; defaults to SKILL.md.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => text(await readSkill(ctx.config, String(args.name), typeof args.path === "string" ? args.path : undefined)),
  },
  {
    name: "mcp_list_servers", title: "List external MCP servers",
    description: "List external MCP servers configured in the harness and their connection status. Use mcp_list to discover their capabilities.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => text(safeJson(ctx.externalMcp.list(), ctx.config.maxOutputChars)),
  },
  {
    name: "mcp_list", title: "Discover external MCP capabilities",
    description: "Connect to a configured MCP server and list its tools, resources, resource templates or prompts, including schemas and pagination cursor. Tool names and schemas come from that server.",
    inputSchema: {
      server: serverField,
      kind: z.enum(["tools", "resources", "resource_templates", "prompts"]),
      cursor: z.string().optional().describe("Cursor from a previous list response."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const signal = ctx.turnSignal;
      signal?.throwIfAborted();
      const client = await ctx.externalMcp.connect(String(args.server));
      signal?.throwIfAborted();
      const params = typeof args.cursor === "string" ? { cursor: args.cursor } : {};
      const options = { signal };
      const result = args.kind === "tools" ? await client.listTools(params, options)
        : args.kind === "resources" ? await client.listResources(params, options)
        : args.kind === "resource_templates" ? await client.listResourceTemplates(params, options)
        : await client.listPrompts(params, options);
      return text(safeJson(result, ctx.config.maxOutputChars));
    },
  },
  {
    name: "mcp_call_tool", title: "Call an external MCP tool",
    description: "Call a tool from a configured MCP server using the schema returned by mcp_list. External tools can have side effects; each call requires local approval in ask mode. Do not repeat denied calls.",
    inputSchema: { server: serverField, tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const signal = ctx.turnSignal;
      const server = String(args.server);
      const tool = String(args.tool);
      const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
      signal?.throwIfAborted();
      const approval = await ctx.approvals.request("mcp_call_tool", args, `External MCP server: ${server}\nTool: ${tool}\nArguments (preview may be truncated):\n${safeJson(toolArgs, 1200)}`, 70_000, ctx.approvalScope);
      if (!approval.allowed) return errorText("The user denied this external MCP tool call.");
      signal?.throwIfAborted();
      const client = await ctx.externalMcp.connect(server);
      signal?.throwIfAborted();
      const result = await client.callTool({ name: tool, arguments: toolArgs }, undefined, { signal });
      if (!("content" in result) || !Array.isArray(result.content)) return text(safeJson(result, ctx.config.maxOutputChars));
      const content: ToolContent[] = result.content.map((item): ToolContent => {
        if (item.type === "text") return { type: "text", text: truncate(item.text, ctx.config.maxOutputChars) };
        if (item.type === "image") return { type: "image", data: item.data, mimeType: item.mimeType };
        return { type: "text", text: safeJson(item, ctx.config.maxOutputChars) };
      });
      if (result.structuredContent) content.push({ type: "text", text: safeJson(result.structuredContent, ctx.config.maxOutputChars) });
      return { content: content.length ? content : [{ type: "text", text: "(empty result)" }], isError: result.isError === true };
    },
  },
  {
    name: "mcp_read_resource", title: "Read an external MCP resource",
    description: "Read a resource URI listed by a configured MCP server.",
    inputSchema: { server: serverField, uri: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const signal = ctx.turnSignal;
      signal?.throwIfAborted();
      const client = await ctx.externalMcp.connect(String(args.server));
      signal?.throwIfAborted();
      return text(safeJson(await client.readResource({ uri: String(args.uri) }, { signal }), ctx.config.maxOutputChars));
    },
  },
  {
    name: "mcp_get_prompt", title: "Read an external MCP prompt",
    description: "Get a prompt from a configured MCP server. Discover prompt names and argument names with mcp_list first.",
    inputSchema: { server: serverField, prompt: z.string().min(1), arguments: z.record(z.string(), z.string()).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const signal = ctx.turnSignal;
      signal?.throwIfAborted();
      const client = await ctx.externalMcp.connect(String(args.server));
      signal?.throwIfAborted();
      return text(safeJson(await client.getPrompt({ name: String(args.prompt), arguments: args.arguments as Record<string, string> | undefined }, { signal }), ctx.config.maxOutputChars));
    },
  },
];

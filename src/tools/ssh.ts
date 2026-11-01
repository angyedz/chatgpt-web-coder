import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { expandHome, resolveInside } from "../utils/paths.js";
import { oneLine, truncate } from "../utils/text.js";
import { errorText, text, type ToolContext, type ToolDefinition, type ToolResult } from "./types.js";

const connectionSchema = {
  host: z.string().min(1).max(253).describe("SSH host name, IP address, or alias in the user's SSH config."),
  user: z.string().min(1).max(128).optional().describe("Remote user; omit to use SSH config or the local user."),
  port: z.number().int().min(1).max(65535).optional().describe("SSH port; omit to use SSH config."),
  identity_file: z.string().min(1).optional().describe("Path to an existing private key. The key is read by OpenSSH, not returned to ChatGPT."),
};

function connection(args: Record<string, unknown>): { host: string; label: string; sshArgs: string[]; sftpArgs: string[] } {
  const host = String(args.host);
  const user = typeof args.user === "string" ? args.user : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(host)) throw new Error("Invalid SSH host. Use a hostname, IP address, or SSH config alias.");
  if (user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) throw new Error("Invalid SSH username.");
  const common = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"];
  if (typeof args.identity_file === "string") {
    if (/[\0\r\n]/.test(args.identity_file)) throw new Error("Invalid identity file path.");
    common.push("-i", path.resolve(expandHome(args.identity_file)));
  }
  const sshArgs = [...common, "-T"];
  const sftpArgs = [...common, "-b", "-"];
  if (typeof args.port === "number") { sshArgs.push("-p", String(args.port)); sftpArgs.push("-P", String(args.port)); }
  if (user) sshArgs.push("-l", user);
  const label = `${user ? `${user}@` : ""}${host}${typeof args.port === "number" ? `:${args.port}` : ""}`;
  return { host: user ? `${user}@${host}` : host, label, sshArgs, sftpArgs };
}

function remotePath(value: unknown): string {
  const result = String(value);
  if (!result || result.startsWith("-") || /[\0\r\n]/.test(result)) throw new Error("Invalid remote path. Prefix names starting with '-' with './'.");
  return result;
}

function sftpQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Paths cannot contain control characters or newlines.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function approved(ctx: ToolContext, tool: string, args: Record<string, unknown>, summary: string): Promise<{ allowed: boolean; reason?: string }> {
  ctx.turnSignal?.throwIfAborted();
  const result = await ctx.approvals.request(tool, args, summary, 70_000, ctx.approvalScope);
  if (result.allowed) ctx.turnSignal?.throwIfAborted();
  return result;
}

function format(result: Awaited<ReturnType<ToolContext["exec"]["runExecutable"]>>, ctx: ToolContext): ToolResult {
  const status = result.running
    ? `Still running (session: ${result.sessionId}). Use write_stdin or inspect_exec_session.`
    : `${result.timedOut ? "Timed out. " : ""}Finished with exit code ${result.exitCode ?? "?"} in ${result.durationMs} ms.${result.sessionId ? ` Session: ${result.sessionId}.` : ""}`;
  const message = `${status}\n\n${truncate(result.output.trimEnd() || "(no output)", ctx.config.maxOutputChars)}`;
  return !result.running && result.exitCode !== 0 ? errorText(message) : text(message);
}

export const sshTools: ToolDefinition[] = [
  {
    name: "ssh_exec", title: "Run a command over SSH",
    description: "Run a non-interactive command on an SSH host using the user's OpenSSH config, agent or key. The host key must already be trusted. Requires approval in ask mode; use background=true for long-running commands, then inspect or stop the returned exec session. Never put passwords or private keys in tool arguments.",
    inputSchema: {
      ...connectionSchema,
      command: z.string().min(1).max(16000).describe("Command executed by the remote shell."),
      background: z.boolean().optional().describe("Keep the SSH process running in the background."),
      yield_time_ms: z.number().int().min(250).max(60000).optional(),
      timeout_ms: z.number().int().min(100).max(2147000000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const target = connection(args);
      const command = String(args.command);
      if (command.includes("\0")) return errorText("SSH command contains an invalid character.");
      const approval = await approved(ctx, "ssh_exec", args, `SSH: ${target.label}\nRemote command:\n${oneLine(command, 500)}`);
      if (!approval.allowed) return errorText(`SSH command was not started. Approval outcome: ${approval.reason ?? "denied by the user"}.`);
      const background = typeof args.background === "boolean" ? args.background : Boolean(ctx.approvalScope);
      const result = await ctx.exec.runExecutable("ssh", [...target.sshArgs, target.host, command], {
        workdir: ctx.workspace,
        background,
        yieldTimeMs: typeof args.yield_time_ms === "number" ? args.yield_time_ms : background ? 250 : 10000,
        timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        displayCommand: `ssh ${target.label}: ${oneLine(command, 240)}`,
      });
      return format(result, ctx);
    },
  },
  ...(["upload", "download"] as const).map((direction): ToolDefinition => ({
    name: `ssh_${direction}`,
    title: direction === "upload" ? "Upload a file over SFTP" : "Download a file over SFTP",
    description: `${direction === "upload" ? "Upload a local workspace file to an SSH server" : "Download a remote file into the workspace"} using non-interactive OpenSSH SFTP. The host key must already be trusted. Each transfer requires approval in ask mode. Local paths are confined to the workspace; existing files may be overwritten.`,
    inputSchema: {
      ...connectionSchema,
      local_path: z.string().min(1).describe("File path inside the workspace."),
      remote_path: z.string().min(1).describe("File path on the SSH server."),
      timeout_ms: z.number().int().min(100).max(2147000000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const target = connection(args);
      const localArg = String(args.local_path);
      const local = resolveInside(ctx.workspace, localArg);
      const remote = remotePath(args.remote_path);
      const localInfo = await stat(local).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (direction === "upload" && !localInfo?.isFile()) return errorText(`Local file does not exist: ${localArg}`);
      if (direction === "download" && localInfo && !localInfo.isFile()) return errorText(`Local destination is not a regular file: ${localArg}`);
      if (direction === "download" && !(await stat(path.dirname(local))).isDirectory()) return errorText("Local destination directory does not exist.");
      const summary = `SFTP ${direction}: ${target.label}\nLocal: ${localArg}\nRemote: ${remote}${direction === "download" && localInfo ? "\nExisting local file will be overwritten." : ""}${direction === "upload" ? "\nAn existing remote file may be overwritten." : ""}`;
      const approval = await approved(ctx, `ssh_${direction}`, args, summary);
      if (!approval.allowed) return errorText(`SFTP ${direction} was not started. Approval outcome: ${approval.reason ?? "denied by the user"}.`);
      resolveInside(ctx.workspace, localArg);
      const operation = direction === "upload" ? `put ${sftpQuote(local)} ${sftpQuote(remote)}` : `get ${sftpQuote(remote)} ${sftpQuote(local)}`;
      const result = await ctx.exec.runExecutable("sftp", [...target.sftpArgs, target.host], {
        workdir: ctx.workspace,
        stdin: `${operation}\n`,
        background: Boolean(ctx.approvalScope),
        yieldTimeMs: ctx.approvalScope ? 250 : 10000,
        timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        displayCommand: `sftp ${direction} ${target.label}: ${localArg} ↔ ${remote}`,
      });
      return format(result, ctx);
    },
  })),
];

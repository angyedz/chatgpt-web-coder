import { copyFile, lstat, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInside, isInside } from "../utils/paths.js";
import { oneLine, safeJson, truncate } from "../utils/text.js";
import { applyPatch } from "./patch.js";
import {
  globFiles,
  grepFiles,
  listDirectory,
  readTextFile,
  relativePath,
  writeTextFile,
} from "./fs.js";
import { fetchWebPage, searxngSearch } from "./search.js";
import { scheduleTimer, describeTimer } from "../runtime/schedule.js";
import { extensionTools } from "./extensions.js";
import { sshTools } from "./ssh.js";
import { formatInstructions, projectInstructions } from "../runtime/instructions.js";
import type { ExecSessionManager } from "./exec.js";
import {
  errorText,
  text,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function backgroundExec(exec: ExecSessionManager): ExecSessionManager {
  return new Proxy(exec, {
    get(target, property) {
      if (property === "run") {
        return (command: string, options: Parameters<ExecSessionManager["run"]>[1] = {}) =>
          target.run(command, { ...options, background: true, yieldTimeMs: options.yieldTimeMs ?? 10_000 });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function requireApproval(
  ctx: ToolContext,
  tool: string,
  summary: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  return ctx.approvals.request(tool, args, summary, 70_000, ctx.approvalScope).then((result) => result.allowed);
}

function formatExecResult(
  result: Awaited<ReturnType<ToolContext["exec"]["run"]>>,
  maxOutputChars: number,
): string {
  const head = result.running
    ? `Still running (session: ${result.sessionId}). Poll it with write_stdin.`
    : `${result.timedOut ? "Timed out. " : ""}Finished with exit code ${result.exitCode ?? "?"} in ${result.durationMs} ms.${result.sessionId ? ` Session: ${result.sessionId}.` : ""}`;
  const output = result.output.trimEnd();
  return `${head}\n\n${truncate(output || "(no output)", maxOutputChars)}`;
}

export const toolDefinitions: ToolDefinition[] = [
  ...extensionTools,
  ...sshTools,
  {
    name: "git_status",
    title: "Git status",
    description: "Show the current branch and changed files in the workspace Git repository.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => {
      const result = await ctx.exec.run("git status --short --branch", { workdir: ctx.workspace });
      return text(formatExecResult(result, ctx.config.maxOutputChars));
    },
  },
  {
    name: "git_diff",
    title: "Git diff",
    description: "Show unstaged and staged changes in the workspace repository. Use max_output_chars to limit large diffs.",
    inputSchema: {
      max_output_chars: z.number().int().min(1000).max(100_000).optional().describe("Maximum returned characters. Default uses the harness output limit."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const maxChars = Math.min(numberArg(args, "max_output_chars", ctx.config.maxOutputChars), ctx.config.maxOutputChars);
      const result = await ctx.exec.run("git diff --no-ext-diff HEAD", { workdir: ctx.workspace });
      return text(formatExecResult(result, maxChars));
    },
  },
  {
    name: "git_log",
    title: "Git history",
    description: "Show recent commits in the workspace repository as a compact one-line history.",
    inputSchema: {
      count: z.number().int().min(1).max(50).optional().describe("Number of commits. Default 10."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const count = numberArg(args, "count", 10);
      const result = await ctx.exec.run(`git log -${count} --oneline --decorate`, { workdir: ctx.workspace });
      return text(formatExecResult(result, ctx.config.maxOutputChars));
    },
  },
  {
    name: "get_workspace_info",
    title: "Workspace info",
    description:
      "Describe the local workspace, operating system, shell, approval policy and available tools. Call this once before your first action if you are unsure about the environment.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => {
      const info = {
        workspace: ctx.workspace,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        shell:
          process.platform === "win32"
            ? process.env.HARNESS_SHELL || "powershell.exe"
            : process.env.HARNESS_SHELL || "/bin/bash",
        approvalMode: ctx.config.approvalMode,
        searxng: ctx.config.searxng.url,
        agentsMd: await exists(path.join(ctx.workspace, "AGENTS.md")),
        gitRepository: await exists(path.join(ctx.workspace, ".git")),
        tools: toolDefinitions.map((tool) => tool.name),
      };
      return text(safeJson(info, 4000));
    },
  },
  {
    name: "exec_command",
    title: "Run a shell command",
    description:
      "Run a shell command in the workspace. Set background=true for long-running servers and jobs; the returned session survives cancellation of the current turn. Use timeout_ms for an optional execution deadline. Poll with write_stdin or inspect_exec_session; never start a duplicate. On Windows the shell is PowerShell.",
    inputSchema: {
      cmd: z.string().min(1).describe("Command line to execute."),
      workdir: z
        .string()
        .optional()
        .describe("Working directory relative to the workspace root. Defaults to the root."),
      yield_time_ms: z
        .number()
        .int()
        .min(250)
        .max(60_000)
        .optional()
        .describe("How long to wait before returning a session id. Default 10000."),
      background: z.boolean().optional().describe("Run as a background job; return quickly and keep it running after the turn."),
      timeout_ms: z.number().int().min(100).max(2_147_000_000).optional().describe("Stop the process tree after this many milliseconds. Omit for no deadline."),
      max_output_chars: z
        .number()
        .int()
        .min(1000)
        .max(100_000)
        .optional()
        .describe("Per-call output cap. Defaults to the harness limit."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const cmd = stringArg(args, "cmd");
      const workdirArg = stringArg(args, "workdir", ".");
      const workdir = resolveInside(ctx.workspace, workdirArg);
      const info = await stat(workdir).catch(() => undefined);
      if (!info?.isDirectory()) {
        return errorText(`Working directory does not exist: ${workdirArg}`);
      }
      const background = boolArg(args, "background", Boolean(ctx.approvalScope));
      const yieldTime = numberArg(args, "yield_time_ms", background ? 250 : 10_000);
      const maxChars = Math.min(
        numberArg(args, "max_output_chars", ctx.config.maxOutputChars),
        ctx.config.maxOutputChars,
      );

      const allowed = await requireApproval(
        ctx,
        "exec_command",
        `Run in ${relativePath(ctx.workspace, workdir)}:\n${oneLine(cmd, 240)}`,
        args,
      );
      if (!allowed) {
        return errorText("The user denied this command.");
      }

      const result = await ctx.exec.run(cmd, {
        workdir,
        yieldTimeMs: yieldTime,
        background,
        timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
      });
      ctx.events.emit({
        type: "notice",
        level: "info",
        text: `${result.running ? "started" : "ran"} exec ${result.sessionId ?? ""}`.trim(),
      });
      return text(formatExecResult(result, maxChars));
    },
  },
  {
    name: "set_timer",
    title: "Set a timer",
    description: "Set a one-shot timer in the running harness. Optionally schedule a shell command to start in the workspace when it expires; command approval is requested when scheduling. Timers do not survive harness shutdown.",
    inputSchema: {
      duration_ms: z.number().int().min(100).max(2_147_000_000).describe("Delay in milliseconds."),
      label: z.string().max(200).optional().describe("Description of the timer."),
      command: z.string().min(1).optional().describe("Optional shell command to launch in the background when the timer expires."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args, ctx) => {
      const command = stringArg(args, "command").trim();
      if (command && !(await requireApproval(ctx, "set_timer", `Schedule a command in ${ctx.workspace}:\n${oneLine(command, 240)}\nAfter ${numberArg(args, "duration_ms", 0)} ms`, args))) {
        return errorText("The user denied the scheduled command.");
      }
      const timer = scheduleTimer(ctx, numberArg(args, "duration_ms", 0), stringArg(args, "label", command || "Timer"), command || undefined);
      return text(`Timer scheduled: ${describeTimer(timer)}. Timers run only while the harness is open.`);
    },
  },
  {
    name: "list_timers",
    title: "List timers",
    description: "List pending harness timers and scheduled commands.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => text(ctx.timers.list().map(describeTimer).join("\n") || "No active timers."),
  },
  {
    name: "cancel_timer",
    title: "Cancel a timer",
    description: "Cancel a pending timer before it fires; this does not stop a command that has already started.",
    inputSchema: { timer_id: z.string().min(1).describe("Timer ID returned by set_timer.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args, ctx) => {
      const id = stringArg(args, "timer_id");
      return text(ctx.timers.cancel(id) ? `Cancelled timer ${id}.` : `Timer ${id} is not pending.`);
    },
  },
  {
    name: "start_background_task",
    title: "Run a tool in the background",
    description: "Start another harness tool asynchronously and immediately return a task ID. Use list_background_tasks and get_background_task for status and results. Normal approvals still apply. For long-running shell commands, use exec_command with background=true instead. Background work runs only while the harness is open.",
    inputSchema: {
      tool_name: z.string().min(1).describe("Tool to run. This tool cannot invoke itself."),
      arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments for the chosen tool."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const name = stringArg(args, "tool_name");
      const def = findTool(name);
      if (!def || name === "start_background_task") return errorText(`Cannot run background tool: ${name}`);
      const parsed = z.object(def.inputSchema).strict().safeParse(args.arguments ?? {});
      if (!parsed.success) return errorText(`Invalid arguments for ${name}: ${parsed.error.message}`);
      const toolArgs = parsed.data as Record<string, unknown>;
      if (name === "exec_command") toolArgs.background = true;
      if (name === "write_stdin" && typeof toolArgs.session_id === "string") ctx.exec.background(toolArgs.session_id);
      const task = ctx.tasks.start(name, (id) => def.handler(toolArgs, { ...ctx, exec: backgroundExec(ctx.exec), approvalScope: id, turnSignal: undefined }));
      return text(`Started background task ${task.id}: ${name}. Use get_background_task to inspect the result.`);
    },
  },
  {
    name: "list_background_tasks",
    title: "List background tasks",
    description: "List asynchronous harness tool tasks and their status.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => text(safeJson(ctx.tasks.list().map(({ result: _result, ...task }) => task), ctx.config.maxOutputChars)),
  },
  {
    name: "get_background_task",
    title: "Get a background task result",
    description: "Get the status and result of a background tool task, including image results when present.",
    inputSchema: { task_id: z.string().min(1).describe("Task ID returned by start_background_task.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const task = ctx.tasks.get(stringArg(args, "task_id"));
      if (!task) return errorText("Background task not found.");
      if (!task.result) return text(`Task ${task.id} is ${task.status}.`);
      return { ...task.result, content: [{ type: "text", text: `Task ${task.id}: ${task.status}.` }, ...task.result.content] };
    },
  },
  {
    name: "background_exec_session",
    title: "Move a command to the background",
    description: "Keep an existing running exec_command session in the background when the current turn is cancelled.",
    inputSchema: { session_id: z.string().min(1).describe("Running command session ID.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args, ctx) => {
      const id = stringArg(args, "session_id");
      return text(ctx.exec.background(id) ? `Session ${id} is now in the background.` : `Session ${id} is not running.`);
    },
  },
  {
    name: "list_exec_sessions",
    title: "List command sessions",
    description: "List active and retained background command sessions, their status, command and recent output.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => text(safeJson(ctx.exec.list(), ctx.config.maxOutputChars)),
  },
  {
    name: "inspect_exec_session",
    title: "Inspect a command session",
    description: "Inspect command status and recent output without consuming output from write_stdin.",
    inputSchema: { session_id: z.string().min(1).describe("Command session ID.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const session = ctx.exec.inspect(stringArg(args, "session_id"));
      return session ? text(safeJson(session, ctx.config.maxOutputChars)) : errorText("Command session not found.");
    },
  },
  {
    name: "write_stdin",
    title: "Poll a running command",
    description:
      "Send optional input to a command session created by exec_command and return new output. Call repeatedly until running=false. Use empty chars to only poll.",
    inputSchema: {
      session_id: z.string().min(1).describe("Session id returned by exec_command."),
      chars: z
        .string()
        .optional()
        .describe("Text to write to stdin. Use an empty string to only poll."),
      yield_time_ms: z
        .number()
        .int()
        .min(250)
        .max(60_000)
        .optional()
        .describe("How long to wait for new output. Default 10000."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (args, ctx) => {
      const sessionId = stringArg(args, "session_id");
      const chars = stringArg(args, "chars", "");
      const yieldTime = numberArg(args, "yield_time_ms", 10_000);
      try {
        const result = await ctx.exec.write(sessionId, chars, yieldTime);
        return text(formatExecResult(result, ctx.config.maxOutputChars));
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    name: "kill_exec_session",
    title: "Stop a running command",
    description: "Terminate a running exec_command session and its child process tree.",
    inputSchema: {
      session_id: z.string().min(1).describe("Session id returned by exec_command."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const sessionId = stringArg(args, "session_id");
      const killed = await ctx.exec.kill(sessionId);
      return killed ? text(`Stopped session ${sessionId}.`) : errorText(`Session ${sessionId} was not running or its process tree could not be stopped.`);
    },
  },
  {
    name: "read_file",
    title: "Read a file",
    description:
      "Read a UTF-8 text file with line numbers. Use offset and limit for large files. Read files before editing them.",
    inputSchema: {
      path: z.string().min(1).describe("File path relative to the workspace."),
      offset: z.number().int().min(1).optional().describe("First line (1-based). Default 1."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum number of lines. Default 400."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const result = await readTextFile(
        ctx.workspace,
        stringArg(args, "path"),
        numberArg(args, "offset", 1),
        numberArg(args, "limit", 400),
      );
      const instructions = await projectInstructions(ctx.workspace, stringArg(args, "path"));
      return text(`${instructions.length ? `Applicable project instructions:\n${formatInstructions(instructions)}\n\n` : ""}${result.text}`);
    },
  },
  {
    name: "list_dir",
    title: "List a directory",
    description:
      "List a directory tree with sizes. Skips .git and node_modules. Use depth 1-3 to control recursion.",
    inputSchema: {
      path: z.string().optional().describe("Directory relative to the workspace. Default '.'."),
      depth: z.number().int().min(1).max(5).optional().describe("Recursion depth. Default 2."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const result = await listDirectory(
          ctx.workspace,
          stringArg(args, "path", "."),
          numberArg(args, "depth", 2),
        );
      const instructions = await projectInstructions(ctx.workspace, stringArg(args, "path", "."));
      return text(`${instructions.length ? `Applicable project instructions:\n${formatInstructions(instructions)}\n\n` : ""}${result}`);
    },
  },
  {
    name: "glob",
    title: "Find files by glob",
    description:
      "Find files matching a glob such as 'src/**/*.ts' or '**/*.test.ts'. Hidden files are excluded. Returns paths relative to the workspace.",
    inputSchema: {
      pattern: z.string().min(1).describe("Glob pattern."),
      path: z.string().optional().describe("Base directory. Default '.'."),
      limit: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default 200."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) =>
      text(
        await globFiles(
          ctx.workspace,
          stringArg(args, "pattern"),
          stringArg(args, "path", "."),
          numberArg(args, "limit", 200),
        ),
      ),
  },
  {
    name: "grep",
    title: "Search file contents",
    description:
      "Search file contents with a JavaScript regular expression. Returns file:line matches. Use a glob to narrow the search, e.g. 'src/**/*.ts'.",
    inputSchema: {
      pattern: z.string().min(1).describe("Regular expression."),
      path: z.string().optional().describe("Base directory. Default '.'."),
      glob: z.string().optional().describe("Glob filter. Default '**/*'."),
      case_sensitive: z.boolean().optional().describe("Case-sensitive match. Default false."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum matches. Default 100."),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe("Context lines around each match. Default 0."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) =>
      text(
        await grepFiles(ctx.workspace, {
          pattern: stringArg(args, "pattern"),
          basePath: stringArg(args, "path", "."),
          glob: stringArg(args, "glob", "**/*"),
          caseSensitive: boolArg(args, "case_sensitive", false),
          maxResults: numberArg(args, "max_results", 100),
          contextLines: numberArg(args, "context_lines", 0),
        }),
      ),
  },
  {
    name: "apply_patch",
    title: "Apply a patch",
    description:
      "Apply a Codex-style patch to one or more files. Use this for every code edit. Format:\n*** Begin Patch\n*** Update File: path\n@@\n context\n-old line\n+new line\n*** Add File: path\n+new file content\n*** Delete File: path\n*** End Patch\nA hunk may include several context lines. Keep changes small and verify with read_file afterwards.",
    inputSchema: {
      patch: z.string().min(1).describe("Patch text in the Codex apply_patch format."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const patch = stringArg(args, "patch");
      const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map(
        (match) => match[1]?.trim() ?? "",
      );
      const allowed = await requireApproval(
        ctx,
        "apply_patch",
        `Patch ${files.length > 0 ? files.join(", ") : "files"}:\n${oneLine(patch, 400)}`,
        args,
      );
      if (!allowed) return errorText("The user denied this patch.");
      try {
        const result = await applyPatch(ctx.workspace, patch);
        return text(result.summary);
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    name: "write_file",
    title: "Write a complete file",
    description:
      "Create or replace a file with exact content. Prefer apply_patch for edits to existing files; use write_file only for new files or full rewrites.",
    inputSchema: {
      path: z.string().min(1).describe("File path relative to the workspace."),
      content: z.string().describe("Complete file content."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const filePath = stringArg(args, "path");
      const content = stringArg(args, "content");
      const allowed = await requireApproval(
        ctx,
        "write_file",
        `Write ${filePath} (${Buffer.byteLength(content, "utf8")} bytes)`,
        args,
      );
      if (!allowed) return errorText("The user denied this write.");
      return text(await writeTextFile(ctx.workspace, filePath, content));
    },
  },
  {
    name: "create_directory",
    title: "Create a directory",
    description: "Create a workspace directory and any missing parent directories.",
    inputSchema: { path: z.string().min(1).describe("Directory path relative to the workspace.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args, ctx) => {
      const relative = stringArg(args, "path");
      const absolute = resolveInside(ctx.workspace, relative);
      const allowed = await requireApproval(ctx, "create_directory", `Create directory ${relative}`, args);
      if (!allowed) return errorText("The user denied this directory creation.");
      await mkdir(absolute, { recursive: true });
      return text(`Created directory ${relative}.`);
    },
  },
  {
    name: "move_file",
    title: "Move a file",
    description: "Move or rename a regular file inside the workspace. The destination must not already exist.",
    inputSchema: {
      source: z.string().min(1).describe("Source file path relative to the workspace."),
      destination: z.string().min(1).describe("Destination path relative to the workspace."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const source = resolveInside(ctx.workspace, stringArg(args, "source"));
      const destination = resolveInside(ctx.workspace, stringArg(args, "destination"));
      const info = await lstat(source);
      if (!info.isFile()) return errorText("Only regular files can be moved.");
      if (await exists(destination)) return errorText("Destination already exists; refusing to overwrite it.");
      const allowed = await requireApproval(ctx, "move_file", `Move ${stringArg(args, "source")} → ${stringArg(args, "destination")}`, args);
      if (!allowed) return errorText("The user denied this file move.");
      await rename(source, destination);
      return text(`Moved ${stringArg(args, "source")} to ${stringArg(args, "destination")}.`);
    },
  },
  {
    name: "copy_file",
    title: "Copy a file",
    description: "Copy a regular file to another workspace path. The destination must not already exist.",
    inputSchema: {
      source: z.string().min(1).describe("Source file path relative to the workspace."),
      destination: z.string().min(1).describe("Destination path relative to the workspace."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args, ctx) => {
      const source = resolveInside(ctx.workspace, stringArg(args, "source"));
      const destination = resolveInside(ctx.workspace, stringArg(args, "destination"));
      const info = await lstat(source);
      if (!info.isFile()) return errorText("Only regular files can be copied.");
      if (await exists(destination)) return errorText("Destination already exists; refusing to overwrite it.");
      const allowed = await requireApproval(ctx, "copy_file", `Copy ${stringArg(args, "source")} → ${stringArg(args, "destination")}`, args);
      if (!allowed) return errorText("The user denied this file copy.");
      await copyFile(source, destination);
      return text(`Copied ${stringArg(args, "source")} to ${stringArg(args, "destination")}.`);
    },
  },
  {
    name: "delete_file",
    title: "Delete a file",
    description: "Delete a regular file or symbolic link inside the workspace. Directories are not removed.",
    inputSchema: { path: z.string().min(1).describe("File path relative to the workspace.") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const relative = stringArg(args, "path");
      const absolute = resolveInside(ctx.workspace, relative);
      const info = await lstat(absolute);
      if (info.isDirectory()) return errorText("Directories cannot be removed with delete_file.");
      const allowed = await requireApproval(ctx, "delete_file", `Delete ${relative}`, args);
      if (!allowed) return errorText("The user denied this file deletion.");
      await unlink(absolute);
      return text(`Deleted ${relative}.`);
    },
  },
  {
    name: "view_image",
    title: "View an image",
    description:
      "Return an image from the workspace as image content so you can inspect screenshots, diagrams or UI mockups. Supports png, jpeg, gif, webp and svg.",
    inputSchema: {
      path: z.string().min(1).describe("Image path relative to the workspace."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const absolute = resolveInside(ctx.workspace, stringArg(args, "path"));
      const info = await stat(absolute);
      if (info.size > 12 * 1024 * 1024) {
        return errorText("Image is larger than 12 MB.");
      }
      const mime = mimeForPath(absolute);
      if (!mime) {
        return errorText(`Unsupported image type: ${path.extname(absolute)}`);
      }
      const data = (await readFile(absolute)).toString("base64");
      return {
        content: [
          { type: "text", text: `Image: ${relativePath(ctx.workspace, absolute)}` },
          { type: "image", data, mimeType: mime },
        ],
      };
    },
  },
  {
    name: "web_search",
    title: "Search the web",
    description:
      "Search the web through the configured SearXNG instance. Returns titles, URLs and snippets. Use web_fetch to read a promising result.",
    inputSchema: {
      query: z.string().min(1).describe("Search query."),
      count: z.number().int().min(1).max(20).optional().describe("Number of results. Default 8."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      if (!ctx.config.searxng.url) {
        return errorText("SEARXNG_URL is not configured.");
      }
      return text(
        await searxngSearch(
          ctx.config.searxng,
          stringArg(args, "query"),
          numberArg(args, "count", 8),
        ),
      );
    },
  },
  {
    name: "web_fetch",
    title: "Fetch a web page",
    description:
      "Fetch an HTTP(S) page and return readable text (HTML is stripped). Use it after web_search or when the user gives you a URL.",
    inputSchema: {
      url: z.string().url().describe("HTTP(S) URL."),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(100_000)
        .optional()
        .describe("Maximum characters. Default 20000."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args, ctx) =>
      text(
        await fetchWebPage(
          stringArg(args, "url"),
          numberArg(args, "max_chars", 20_000),
        ),
      ),
  },
  {
    name: "update_plan",
    title: "Update the plan",
    description:
      "Update the visible task plan. Keep exactly one step in_progress while working and mark steps completed as you finish them.",
    inputSchema: {
      steps: z
        .array(
          z.object({
            step: z.string().min(1),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .min(1)
        .max(30)
        .describe("Ordered plan steps."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const raw = args.steps;
      if (!Array.isArray(raw)) return errorText("steps must be an array.");
      const steps = raw
        .filter((step): step is { step: string; status: "pending" | "in_progress" | "completed" } =>
          typeof step === "object" &&
          step !== null &&
          typeof (step as Record<string, unknown>).step === "string" &&
          ["pending", "in_progress", "completed"].includes(
            String((step as Record<string, unknown>).status),
          ),
        )
        .map((step) => ({ step: step.step, status: step.status }));
      ctx.plan.update(steps);
      const rendered = steps
        .map((step) =>
          step.status === "completed"
            ? `[x] ${step.step}`
            : step.status === "in_progress"
              ? `[>] ${step.step}`
              : `[ ] ${step.step}`,
        )
        .join("\n");
      return text(`Plan updated:\n${rendered}`);
    },
  },
];

function mimeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return map[ext];
}

async function exists(target: string): Promise<boolean> {
  return stat(target)
    .then(() => true)
    .catch(() => false);
}

export function findTool(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((tool) => tool.name === name);
}

export function isWorkspacePath(workspace: string, target: string): boolean {
  return isInside(workspace, target);
}

export type { ToolContext, ToolDefinition, ToolResult };
export { errorText, text };

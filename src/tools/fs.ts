import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { resolveInside } from "../utils/paths.js";
import { truncate } from "../utils/text.js";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/dist/**",
  "**/.next/**",
  "**/coverage/**",
];

export function relativePath(workspace: string, target: string): string {
  return path.relative(workspace, target).replaceAll("\\", "/") || ".";
}

export async function readTextFile(
  workspace: string,
  filePath: string,
  offset = 1,
  limit = 400,
): Promise<{ path: string; text: string; totalLines: number }> {
  const absolute = resolveInside(workspace, filePath);
  const info = await stat(absolute);
  if (info.isDirectory()) {
    throw new Error(`${filePath} is a directory. Use list_dir instead.`);
  }
  if (info.size > 8 * 1024 * 1024) {
    throw new Error(`${filePath} is too large (${info.size} bytes).`);
  }

  const buffer = await readFile(absolute);
  if (buffer.subarray(0, 8000).includes(0)) {
    throw new Error(`${filePath} looks like a binary file. Use view_image for images.`);
  }

  const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const start = Math.max(0, Math.floor(offset) - 1);
  const count = Math.min(Math.max(1, Math.floor(limit)), 2000);
  const selected = lines.slice(start, start + count);
  const numbered = selected
    .map((line, index) => `${String(start + index + 1).padStart(6)} | ${line}`)
    .join("\n");

  const header = `File: ${relativePath(workspace, absolute)} (lines ${start + 1}-${start + selected.length} of ${lines.length})`;
  const footer =
    start + count < lines.length
      ? `\n... use offset=${start + count + 1} to continue ...`
      : "";

  return {
    path: relativePath(workspace, absolute),
    text: `${header}\n${numbered}${footer}`,
    totalLines: lines.length,
  };
}

export async function listDirectory(
  workspace: string,
  dirPath = ".",
  depth = 2,
): Promise<string> {
  const absolute = resolveInside(workspace, dirPath);
  const info = await stat(absolute);
  if (!info.isDirectory()) {
    throw new Error(`${dirPath} is not a directory.`);
  }

  const maxDepth = Math.min(Math.max(1, Math.floor(depth)), 5);
  const MAX_ENTRIES = 800;
  let entries = 0;
  const lines: string[] = [];

  async function walk(current: string, level: number): Promise<void> {
    if (entries >= MAX_ENTRIES) return;
    const children = await readdir(current, { withFileTypes: true });
    children.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      if (entries >= MAX_ENTRIES) return;
      if (child.name === ".git" || child.name === "node_modules") continue;
      const childPath = path.join(current, child.name);
      const indent = "  ".repeat(level);
      if (child.isDirectory()) {
        lines.push(`${indent}${child.name}/`);
        entries += 1;
        if (level + 1 < maxDepth) await walk(childPath, level + 1);
      } else if (child.isFile()) {
        const size = (await stat(childPath)).size;
        lines.push(`${indent}${child.name} (${formatBytes(size)})`);
        entries += 1;
      }
    }
  }

  await walk(absolute, 0);
  const header = `Directory: ${relativePath(workspace, absolute)} (depth ${maxDepth})`;
  const footer =
    entries >= MAX_ENTRIES ? `\n... listing capped at ${MAX_ENTRIES} entries ...` : "";
  return `${header}\n${lines.join("\n")}${footer}`;
}

export async function globFiles(
  workspace: string,
  pattern: string,
  basePath = ".",
  limit = 200,
): Promise<string> {
  const base = resolveInside(workspace, basePath);
  const matches = await fg(pattern, {
    cwd: base,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORE,
    absolute: true,
  });

  const capped = matches.slice(0, Math.max(1, Math.min(limit, 2000)));
  const relative = capped
    .map((match) => relativePath(workspace, match))
    .sort();
  if (relative.length === 0) {
    return `No files matched ${pattern} in ${relativePath(workspace, base)}.`;
  }
  const suffix =
    matches.length > capped.length
      ? `\n... ${matches.length - capped.length} more matches not shown ...`
      : "";
  return `${relative.length} match(es) for ${pattern}:\n${relative.join("\n")}${suffix}`;
}

export interface GrepOptions {
  pattern: string;
  basePath?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
  contextLines?: number;
}

export async function grepFiles(
  workspace: string,
  options: GrepOptions,
): Promise<string> {
  const base = resolveInside(workspace, options.basePath ?? ".");
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 100, 1000));
  const contextLines = Math.max(0, Math.min(options.contextLines ?? 0, 5));
  const flags = options.caseSensitive ? "" : "i";
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, flags);
  } catch (error) {
    throw new Error(
      `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files = await fg(options.glob ?? "**/*", {
    cwd: base,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORE,
    absolute: true,
  });

  const output: string[] = [];
  const seen = new Set<string>();
  let matches = 0;

  for (const absolute of files) {
    if (matches >= maxResults) break;
    const info = await stat(absolute);
    if (info.size > 2 * 1024 * 1024) continue;

    const buffer = await readFile(absolute);
    if (buffer.subarray(0, 4000).includes(0)) continue;

    const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    const rel = relativePath(workspace, absolute);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!regex.test(line)) continue;

      const from = Math.max(0, i - contextLines);
      const to = Math.min(lines.length - 1, i + contextLines);
      for (let j = from; j <= to; j += 1) {
        const key = `${rel}:${j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const marker = j === i ? ":" : "-";
        output.push(`${rel}:${j + 1}${marker} ${lines[j] ?? ""}`);
      }
      matches += 1;
      if (matches >= maxResults) break;
    }
  }

  if (matches === 0) {
    return `No matches for /${options.pattern}/${flags} in ${relativePath(workspace, base)}.`;
  }

  const suffix =
    matches >= maxResults ? `\n... stopped after ${maxResults} matches ...` : "";
  return `${matches} match(es) for /${options.pattern}/${flags}:\n${output.join("\n")}${suffix}`;
}

export async function writeTextFile(
  workspace: string,
  filePath: string,
  content: string,
): Promise<string> {
  const absolute = resolveInside(workspace, filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${relativePath(
    workspace,
    absolute,
  )}.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function truncateOutput(text: string, max: number): string {
  return truncate(text, max);
}

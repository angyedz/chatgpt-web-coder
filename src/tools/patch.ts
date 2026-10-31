import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "../utils/paths.js";

type FilePatch =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      moveTo?: string;
      hunks: PatchHunk[];
    };

interface PatchHunk {
  header: string;
  lines: string[];
}

export interface ApplyPatchResult {
  summary: string;
  files: string[];
}

export async function applyPatch(
  workspace: string,
  patchText: string,
): Promise<ApplyPatchResult> {
  const patches = parsePatch(patchText);
  if (patches.length === 0) {
    throw new Error("Patch contains no file operations.");
  }

  const summary: string[] = [];
  const files: string[] = [];

  for (const filePatch of patches) {
    const absolute = resolveInside(workspace, normalizePatchPath(filePatch.path));
    const relative = path.relative(workspace, absolute).replaceAll("\\", "/");
    files.push(relative);

    if (filePatch.kind === "add") {
      await mkdir(path.dirname(absolute), { recursive: true });
      const exists = await pathExists(absolute);
      if (exists) {
        throw new Error(`Cannot add file that already exists: ${relative}`);
      }
      const content = filePatch.lines.join("\n");
      await writeFile(absolute, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      summary.push(`A ${relative} (${filePatch.lines.length} lines)`);
      continue;
    }

    if (filePatch.kind === "delete") {
      if (!(await pathExists(absolute))) {
        throw new Error(`Cannot delete missing file: ${relative}`);
      }
      await rm(absolute, { force: false });
      summary.push(`D ${relative}`);
      continue;
    }

    if (!(await pathExists(absolute))) {
      throw new Error(`Cannot update missing file: ${relative}`);
    }

    const originalRaw = await readFile(absolute, "utf8");
    const eol = originalRaw.includes("\r\n") ? "\r\n" : "\n";
    const hadTrailingNewline = originalRaw.endsWith("\n");
    let lines = originalRaw.replace(/\r\n/g, "\n").split("\n");
    if (hadTrailingNewline) lines = lines.slice(0, -1);

    let added = 0;
    let removed = 0;

    for (const hunk of filePatch.hunks) {
      const result = applyHunk(lines, hunk);
      lines = result.lines;
      added += result.added;
      removed += result.removed;
    }

    const nextRaw =
      lines.join(eol) + (hadTrailingNewline || lines.length === 0 ? eol : "");

    if (filePatch.moveTo) {
      const destination = resolveInside(
        workspace,
        normalizePatchPath(filePatch.moveTo),
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, nextRaw, "utf8");
      await rm(absolute, { force: true });
      summary.push(
        `M ${relative} -> ${path.relative(workspace, destination).replaceAll("\\", "/")} (+${added} -${removed})`,
      );
    } else {
      await writeFile(absolute, nextRaw, "utf8");
      summary.push(`M ${relative} (+${added} -${removed})`);
    }
  }

  return { summary: summary.join("\n"), files };
}

function applyHunk(
  lines: string[],
  hunk: PatchHunk,
): { lines: string[]; added: number; removed: number } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let added = 0;
  let removed = 0;

  for (const raw of hunk.lines) {
    if (raw === "" || raw === "\\ No newline at end of file") {
      oldLines.push("");
      newLines.push("");
      continue;
    }
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === " ") {
      oldLines.push(body);
      newLines.push(body);
    } else if (marker === "-") {
      oldLines.push(body);
      removed += 1;
    } else if (marker === "+") {
      newLines.push(body);
      added += 1;
    } else {
      // Tolerant fallback for models that forget the leading space.
      oldLines.push(raw);
      newLines.push(raw);
    }
  }

  if (oldLines.length === 0) {
    const headerStart = parseHunkStart(hunk.header);
    const index = Math.max(0, Math.min(lines.length, headerStart));
    return {
      lines: [...lines.slice(0, index), ...newLines, ...lines.slice(index)],
      added,
      removed,
    };
  }

  let index = findSequence(lines, oldLines, 0);
  if (index < 0) {
    index = findSequence(lines, oldLines, 0, true);
  }
  if (index < 0) {
    throw new Error(`Patch context was not found:\n${formatHunk(hunk)}`);
  }
  const second = findSequence(lines, oldLines, index + 1);
  if (second >= 0) {
    throw new Error(`Patch context is not unique:\n${formatHunk(hunk)}`);
  }

  return {
    lines: [...lines.slice(0, index), ...newLines, ...lines.slice(index + oldLines.length)],
    added,
    removed,
  };
}

function findSequence(
  haystack: string[],
  needle: string[],
  from: number,
  tolerant = false,
): number {
  const limit = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= limit; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      const left = haystack[i + j] ?? "";
      const right = needle[j] ?? "";
      if (left !== right && !(tolerant && left.trimEnd() === right.trimEnd())) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function parseHunkStart(header: string): number {
  const match = header.match(/@@\s*(?:-(\d+)(?:,\d+)?\s+)?\+(\d+)(?:,\d+)?\s*@@/);
  if (!match?.[2]) return Number.MAX_SAFE_INTEGER;
  return Number(match[2]) - 1;
}

function formatHunk(hunk: PatchHunk): string {
  return [hunk.header, ...hunk.lines].join("\n");
}

function parsePatch(input: string): FilePatch[] {
  let text = input.replace(/\r\n/g, "\n").trim();
  const fence = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fence?.[1] !== undefined) {
    text = fence[1].trim();
  }

  const lines = text.split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line) => line.trim() === "*** End Patch");
  const slice =
    begin >= 0
      ? lines.slice(begin + 1, end > begin ? end : lines.length)
      : lines.slice(0, end >= 0 ? end : lines.length);

  const patches: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: PatchHunk | undefined;

  const flushHunk = () => {
    if (current?.kind === "update" && hunk) {
      current.hunks.push(hunk);
    }
    hunk = undefined;
  };

  for (const line of slice) {
    const add = line.match(/^\*\*\* Add File:\s*(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s*(.+)$/);
    const upd = line.match(/^\*\*\* Update File:\s*(.+)$/);
    const move = line.match(/^\*\*\* Move to:\s*(.+)$/);
    const hunkStart = line.startsWith("@@");

    if (add || del || upd) {
      flushHunk();
      const filePath = (add?.[1] ?? del?.[1] ?? upd?.[1] ?? "").trim();
      if (!filePath) throw new Error(`Invalid patch header: ${line}`);
      if (add) {
        current = { kind: "add", path: filePath, lines: [] };
      } else if (del) {
        current = { kind: "delete", path: filePath };
      } else {
        current = { kind: "update", path: filePath, hunks: [] };
      }
      patches.push(current);
      continue;
    }

    if (move) {
      if (current?.kind !== "update") {
        throw new Error("*** Move to must follow *** Update File");
      }
      current.moveTo = move[1]!.trim();
      continue;
    }

    if (hunkStart) {
      flushHunk();
      if (current?.kind !== "update") {
        throw new Error("A hunk must follow *** Update File");
      }
      hunk = { header: line, lines: [] };
      continue;
    }

    if (line.trim() === "") {
      if (current?.kind === "add") {
        current.lines.push("");
      } else if (hunk) {
        hunk.lines.push(" ");
      }
      continue;
    }

    if (!current) {
      throw new Error(`Unexpected patch line: ${line}`);
    }

    if (current.kind === "add") {
      current.lines.push(line.startsWith("+") ? line.slice(1) : line);
      continue;
    }

    if (current.kind === "update") {
      if (!hunk) {
        hunk = { header: "@@", lines: [] };
      }
      hunk.lines.push(line);
      continue;
    }

    throw new Error(`Unexpected line in delete patch: ${line}`);
  }

  flushHunk();
  return patches;
}

function normalizePatchPath(input: string): string {
  let value = input.trim().replaceAll("\\", "/");
  if (value.startsWith("./")) value = value.slice(2);
  return value;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "../utils/paths.js";
import { truncate } from "../utils/text.js";

export interface InstructionFile { path: string; content: string }

// Ancestors are ordered from least to most specific. An override replaces the
// regular AGENTS.md at the same level, not instructions from other levels.
export async function projectInstructions(workspace: string, target = "."): Promise<InstructionFile[]> {
  const root = path.resolve(workspace);
  const resolved = resolveInside(root, target);
  let directory = resolved;
  try {
    if (!(await stat(resolved)).isDirectory()) directory = path.dirname(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    directory = path.dirname(resolved);
  }
  const directories: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    directories.unshift(current);
    if (path.dirname(current) === current) break;
  }
  const result: InstructionFile[] = [];
  let remaining = 60_000;
  for (const dir of directories) {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "agents.md"]) {
      const file = path.join(dir, name);
      try {
        const contents = await readFile(file, "utf8");
        const content = truncate(contents.trim(), Math.max(0, Math.min(20_000, remaining)));
        result.push({ path: file, content });
        remaining -= Math.min(contents.trim().length, Math.max(0, remaining), 20_000);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      }
    }
    if (dir === root && remaining > 0) {
      try {
        const file = resolveInside(root, path.join(".codex", "AGENTS.md"));
        const content = (await readFile(file, "utf8")).trim();
        result.push({ path: file, content: truncate(content, Math.min(20_000, remaining)) });
        remaining -= Math.min(content.length, remaining, 20_000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      }
    }
    if (remaining <= 0) break;
  }
  return result;
}

export function formatInstructions(files: InstructionFile[]): string {
  return files.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n");
}

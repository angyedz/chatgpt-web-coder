import os from "node:os";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parse } from "yaml";
import type { HarnessConfig } from "../config.js";
import { expandHome, resolveInside } from "../utils/paths.js";
import { truncate } from "../utils/text.js";

export interface Skill { name: string; description: string; directory: string; file: string }

export async function discoverSkills(config: HarnessConfig): Promise<Skill[]> {
  const root = config.workspace;
  const roots = [
    ...config.skills.paths.map((item) => path.resolve(root, expandHome(item))),
    path.join(root, ".agents", "skills"), path.join(root, ".codex", "skills"),
    path.join(root, ".claude", "skills"), path.join(root, ".chatgpt-coder", "skills"),
    path.join(os.homedir(), ".agents", "skills"), path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".chatgpt-coder", "skills"),
  ];
  const found = new Map<string, Skill>();
  for (const base of roots) {
    for (const folder of [base, path.join(base, ".system")]) {
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const directory = path.join(folder, entry.name);
        const file = path.join(directory, "SKILL.md");
        try {
          if ((await stat(file)).size > 2_000_000) continue;
          const content = await readFile(file, "utf8");
          const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
          if (!frontmatter) continue;
          const meta: unknown = parse(frontmatter[1]!);
          if (!meta || typeof meta !== "object") continue;
          const record = meta as Record<string, unknown>;
          if (typeof record.name !== "string" || typeof record.description !== "string" || !record.name.trim()) continue;
          const name = record.name.trim();
          if (!found.has(name)) found.set(name, { name, description: truncate(record.description.trim(), 600), directory, file });
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          // A malformed skill should not prevent all other skills from loading.
          if (error instanceof Error && error.name.startsWith("YAML")) continue;
          throw error;
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(config: HarnessConfig, name: string, relative = "SKILL.md"): Promise<string> {
  const skill = (await discoverSkills(config)).find((item) => item.name === name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  const file = resolveInside(skill.directory, relative);
  const info = await stat(file);
  if (!info.isFile() || info.size > 1_000_000) throw new Error("Skill file must be a regular file no larger than 1 MB.");
  return truncate(await readFile(file, "utf8"), config.maxOutputChars);
}

import os from "node:os";
import path from "node:path";
import { mkdirSync, realpathSync } from "node:fs";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function harnessHome(): string {
  const custom = process.env.CHATGPT_CODER_HOME;
  const home = custom ? expandHome(custom) : path.join(os.homedir(), ".chatgpt-coder");
  mkdirSync(home, { recursive: true });
  return home;
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveInside(root: string, candidate: string): string {
  const resolved = path.resolve(root, candidate);
  if (!isInside(root, resolved)) {
    throw new Error(`Path escapes the workspace: ${candidate}`);
  }
  const realRoot = realpathSync(root);
  let probe = resolved;
  while (true) {
    try {
      const realProbe = realpathSync(probe);
      if (!isInside(realRoot, realProbe)) {
        throw new Error(`Path escapes the workspace through a symbolic link: ${candidate}`);
      }
      break;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
        continue;
      }
      throw error;
    }
  }
  return resolved;
}

export function toPosix(input: string): string {
  return input.replaceAll("\\", "/");
}

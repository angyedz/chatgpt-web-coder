import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  globFiles,
  grepFiles,
  listDirectory,
  readTextFile,
  writeTextFile,
} from "../src/tools/fs.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "cc-fs-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("filesystem tools", () => {
  it("writes and reads numbered lines", async () => {
    await writeTextFile(workspace, "src/a.ts", "alpha\nbeta\ngamma\n");
    const result = await readTextFile(workspace, "src/a.ts", 2, 1);
    expect(result.totalLines).toBe(3);
    expect(result.text).toContain("2 | beta");
    expect(result.text).not.toContain("alpha");
  });

  it("rejects path traversal", async () => {
    await expect(readTextFile(workspace, "../secret.txt")).rejects.toThrow(
      /escapes the workspace/i,
    );
  });

  it("lists a directory", async () => {
    await writeTextFile(workspace, "src/a.ts", "a");
    await writeTextFile(workspace, "src/deep/b.ts", "b");
    const listing = await listDirectory(workspace, ".", 2);
    expect(listing).toContain("src/");
    expect(listing).toContain("a.ts");
    expect(listing).toContain("deep/");
  });

  it("finds files with glob", async () => {
    await writeTextFile(workspace, "src/a.ts", "a");
    await writeTextFile(workspace, "src/b.js", "b");
    const result = await globFiles(workspace, "**/*.ts", ".", 10);
    expect(result).toContain("src/a.ts");
    expect(result).not.toContain("src/b.js");
  });

  it("greps file contents with context", async () => {
    await writeTextFile(
      workspace,
      "src/a.ts",
      "const first = 1;\nconst needle = 2;\nconst last = 3;\n",
    );
    const result = await grepFiles(workspace, {
      pattern: "needle",
      basePath: ".",
      glob: "**/*.ts",
      contextLines: 1,
    });
    expect(result).toContain("src/a.ts:2:");
    expect(result).toContain("first");
    expect(result).toContain("last");
  });
});

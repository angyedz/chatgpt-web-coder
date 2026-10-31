import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch } from "../src/tools/patch.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "cc-patch-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("applyPatch", () => {
  it("adds, updates and deletes files", async () => {
    await writeFile(path.join(workspace, "README.md"), "# Demo\nold\nend\n");
    await writeFile(path.join(workspace, "remove.txt"), "bye\n");

    const result = await applyPatch(
      workspace,
      [
        "*** Begin Patch",
        "*** Add File: src/hello.ts",
        '+export const hello = "world";',
        "*** Update File: README.md",
        "@@",
        " # Demo",
        "-old",
        "+new",
        " end",
        "*** Delete File: remove.txt",
        "*** End Patch",
      ].join("\n"),
    );

    expect(result.summary).toContain("A src/hello.ts");
    expect(result.summary).toContain("M README.md");
    expect(result.summary).toContain("D remove.txt");
    expect(await readFile(path.join(workspace, "src/hello.ts"), "utf8")).toBe(
      'export const hello = "world";\n',
    );
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe(
      "# Demo\nnew\nend\n",
    );
  });

  it("applies multiple hunks to one file", async () => {
    await writeFile(
      path.join(workspace, "a.txt"),
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    );

    await applyPatch(
      workspace,
      [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        " one",
        "-two",
        "+TWO",
        " three",
        "@@",
        " five",
        "-six",
        "+SIX",
        " seven",
        "*** End Patch",
      ].join("\n"),
    );

    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe(
      "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n",
    );
  });

  it("supports moving a file", async () => {
    await writeFile(path.join(workspace, "old.txt"), "hello\n");
    await applyPatch(
      workspace,
      [
        "*** Begin Patch",
        "*** Update File: old.txt",
        "*** Move to: nested/new.txt",
        "@@",
        "-hello",
        "+hello world",
        "*** End Patch",
      ].join("\n"),
    );

    const moved = path.join(workspace, "nested/new.txt");
    expect(await readFile(moved, "utf8")).toBe("hello world\n");
  });

  it("rejects ambiguous context", async () => {
    await writeFile(path.join(workspace, "dup.txt"), "same\nsame\n");
    await expect(
      applyPatch(
        workspace,
        [
          "*** Begin Patch",
          "*** Update File: dup.txt",
          "@@",
          "-same",
          "+different",
          "*** End Patch",
        ].join("\n"),
      ),
    ).rejects.toThrow(/not unique/i);
  });

  it("rejects paths outside the workspace", async () => {
    await expect(
      applyPatch(
        workspace,
        [
          "*** Begin Patch",
          "*** Add File: ../escape.txt",
          "+nope",
          "*** End Patch",
        ].join("\n"),
      ),
    ).rejects.toThrow(/escapes the workspace/i);
  });

  it("accepts a fenced patch", async () => {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src/index.ts"), "let value = 1;\n");
    await applyPatch(
      workspace,
      [
        "```diff",
        "*** Begin Patch",
        "*** Update File: src/index.ts",
        "@@",
        "-let value = 1;",
        "+let value = 2;",
        "*** End Patch",
        "```",
      ].join("\n"),
    );
    expect(await readFile(path.join(workspace, "src/index.ts"), "utf8")).toBe(
      "let value = 2;\n",
    );
  });
});

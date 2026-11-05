import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const helper = fileURLToPath(new URL("../scripts/stamp-build-version.cjs", import.meta.url));

async function prepare() {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-version-"));
  directories.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "chatgpt-coder", version: "0.2.43" }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    name: "chatgpt-coder", version: "0.2.43",
    lockfileVersion: 3, packages: { "": { name: "chatgpt-coder", version: "0.2.43" } },
  }));
  return root;
}
const read = async (root: string, name: string) =>
  JSON.parse(await readFile(path.join(root, name), "utf8")) as { version: string; packages?: Record<string, { version: string }> };

describe("unique CI build versions", () => {
  it("stamps the package and lockfile consistently and without losing the base version", async () => {
    const root = await prepare();
    execFileSync(process.execPath, [helper, "0.2.43+build.42078111496.1"], { cwd: root });
    expect((await read(root, "package.json")).version).toBe("0.2.43+build.42078111496.1");
    const lock = await read(root, "package-lock.json");
    expect(lock.version).toBe("0.2.43+build.42078111496.1");
    expect(lock.packages?.[""]?.version).toBe("0.2.43+build.42078111496.1");
  });

  it("rejects mismatched bases and invalid build identifiers instead of publishing a misleading release", async () => {
    const root = await prepare();
    expect(() => execFileSync(process.execPath, [helper, "0.2.44+build.123.1"], { cwd: root, stdio: "pipe" })).toThrow();
    expect(() => execFileSync(process.execPath, [helper, "0.2.43"], { cwd: root, stdio: "pipe" })).toThrow();
    expect((await read(root, "package.json")).version).toBe("0.2.43");
  });
});

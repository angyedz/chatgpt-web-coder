import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSwarmReports, readSwarmReport, saveSwarmReport, type SwarmReport } from "../src/agent/swarm-reports.js";

const folders: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-reports-"));
  folders.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const sample: SwarmReport = {
  id: "run-123",
  objective: "Check quality",
  savedAt: 1740000000000,
  agents: [{
    id: "1",
    role: "Tests & verification",
    objective: "Check quality",
    status: "done",
    workspace: "/temporary/isolated-worktree",
    branch: "chatgpt-coder/swarm-run-123-1",
    toolCount: 7,
    startedAt: 1739999999000,
    finishedAt: 1740000000000,
    summary: "7 tests passed",
  }],
};

describe("swarm report persistence", () => {
  it("saves an atomic JSON report and reads its full worker summary", async () => {
    const root = await directory();
    await saveSwarmReport(sample, root);
    expect(await readSwarmReport(sample.id, root)).toEqual(sample);
    expect((await readFile(path.join(root, "run-123.json"), "utf8"))).toContain("7 tests passed");
    expect(await listSwarmReports(root)).toEqual([sample]);
  });

  it("overwrites snapshots and orders saved runs newest first", async () => {
    const root = await directory();
    await saveSwarmReport(sample, root);
    await saveSwarmReport({ ...sample, id: "run-456", savedAt: sample.savedAt + 1 }, root);
    await saveSwarmReport({ ...sample, objective: "Finished after resume" }, root);
    expect((await readSwarmReport("run-123", root)).objective).toBe("Finished after resume");
    expect((await listSwarmReports(root)).map((report) => report.id)).toEqual(["run-456", "run-123"]);
    expect((await listSwarmReports(root, 1))).toHaveLength(1);
  });

  it("returns no history in a missing directory, rejects unsafe run IDs", async () => {
    const root = await directory();
    expect(await listSwarmReports(path.join(root, "missing"))).toEqual([]);
    await expect(readSwarmReport("../escape", root)).rejects.toThrow("Invalid");
    await expect(saveSwarmReport({ ...sample, id: "/absolute" }, root)).rejects.toThrow("Invalid");
  });
});

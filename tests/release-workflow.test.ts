import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (name: string): any =>
  YAML.parse(readFileSync(path.join(repo, ".github/workflows", name), "utf8"));
const build = load("windows-release.yml");
const publish = load("publish-verified-release.yml");

describe("Windows release policy", () => {
  it("builds and verifies every branch push, PR and manual dispatch", () => {
    expect(build.on.push.branches).toContain("**");
    expect(build.on).toHaveProperty("pull_request");
    expect(build.on).toHaveProperty("workflow_dispatch");
    expect(build.jobs).not.toHaveProperty("release");
    expect(build.jobs.build.steps.some((step: any) => step.name === "Run tests")).toBe(true);
  });

  it("publishes only verified same-repository results from a separate trusted workflow", () => {
    expect(publish.on.workflow_run.workflows).toContain("Windows CI and release");
    expect(publish.on.workflow_run.types).toContain("completed");
    expect(publish.jobs.publish.if).toContain("workflow_run.conclusion == 'success'");
    expect(publish.jobs.publish.if).toContain("workflow_run.head_repository.full_name == github.repository");
    expect(publish.permissions.contents).toBe("write");
    expect(publish.permissions.actions).toBe("read");
    const download = publish.jobs.publish.steps.find((step: any) => step.name.includes("Download"));
    expect(download.with["run-id"]).toContain("workflow_run.id");
  });

  it("verifies the archive before creating stable or prerelease channels", () => {
    const script = publish.jobs.publish.steps.find((step: any) => step.run?.includes("gh release create"))?.run ?? "";
    expect(script).toContain("sha256sum --check SHA256SUMS.txt");
    expect(script).toContain("--prerelease --latest=false");
    expect(script).toContain("source_sha");
    expect(script).toContain('--target "$source_sha"');
    expect(script).toContain("release/chatgpt-coder-windows.zip");
  });
});

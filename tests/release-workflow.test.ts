import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = YAML.parse(readFileSync(path.join(repo, ".github/workflows/windows-release.yml"), "utf8")) as {
  on: { push: { branches: string[] }; pull_request: unknown; workflow_dispatch: unknown };
  jobs: {
    build: { steps: Array<{ name: string; with?: { ref?: string } }> };
    release: { if: string; permissions: { contents: string }; steps: Array<{ run?: string }> };
  };
};

describe("Windows release policy", () => {
  it("builds pushes from all branch namespaces", () => {
    expect(workflow.on.push.branches).toContain("**");
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("publishes trusted PR builds but never grants fork PRs release permissions", () => {
    const condition = workflow.jobs.release.if;
    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow.jobs.release.permissions.contents).toBe("write");
    const checkout = workflow.jobs.build.steps.find((step) => step.name === "Check out source");
    expect(checkout?.with?.ref).toContain("github.event.pull_request.head.sha");
  });

  it("keeps preview releases out of latest and verifies the archive checksum", () => {
    const script = workflow.jobs.release.steps.find((step) => step.run?.includes("gh release create"))?.run ?? "";
    expect(script).toContain("sha256sum --check SHA256SUMS.txt");
    expect(script).toContain("--prerelease --latest=false");
    expect(script).toContain("source_sha");
    expect(script).toContain("--target \"$source_sha\"");
    expect(script).toContain("release/chatgpt-coder-windows.zip");
  });
});

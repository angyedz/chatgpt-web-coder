import { describe, expect, it } from "vitest";
import { selectReleaseByChannel } from "../src/runtime/github-updates.js";
import { defaultConfig } from "../src/config.js";

describe("two update channels", () => {
  const releases = [
    { tag_name: "build-111-1", draft: false, prerelease: false },
    { tag_name: "preview-pr-9-222-1", draft: false, prerelease: true },
    { tag_name: "prerelease-333-1", draft: false, prerelease: true },
    { tag_name: "prerelease-444-1", draft: true, prerelease: true },
    { tag_name: "prerelease-222-1", draft: false, prerelease: true },
  ];
  it("defaults the installed harness to stable updates", () => {
    expect(defaultConfig().updates.channel).toBe("stable");
  });
  it("selects a published prerelease only from the dedicated tag scheme", () => {
    expect(selectReleaseByChannel(releases, "pre-release")?.tag_name).toBe("prerelease-333-1");
  });
  it("rejects PR previews and draft releases even if newer", () => {
    expect(selectReleaseByChannel(releases.slice(0, 2), "pre-release")).toBeUndefined();
    expect(selectReleaseByChannel(releases.slice(3, 4), "pre-release")).toBeUndefined();
  });
  it("selects only stable releases in stable mode", () => {
    expect(selectReleaseByChannel(releases, "stable")?.tag_name).toBe("build-111-1");
  });
});

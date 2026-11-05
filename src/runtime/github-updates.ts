import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { harnessHome } from "../utils/paths.js";
import { discardUpdate, installedReleaseSource, prepareUpdate, type UpdatePackage } from "./updates.js";
import { APP_VERSION } from "./version.js";
import type { UpdateChannel } from "../config.js";

const MAX_ARCHIVE = 100 * 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;
const allowedDownloadHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);

export interface GithubRelease {
  repository: string;
  tag: string;
  name: string;
  url: string;
  downloadUrl: string;
  sha256: string;
  size: number;
  commit?: string;
  comparison: "current" | "different" | "older" | "unknown";
}

/** Compare release tracks by their base SemVer. The build identifier is
 * unique per CI artifact and is compared using installed release identity. */
export function stableVersion(value: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function validateGithubRepository(value: string): string {
  const repository = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || /\/(?:\.|\.\.)$/.test(repository)) throw new Error("Use a GitHub repository in owner/name format, for example angyedz/chatgpt-web-coder.");
  return repository;
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("GitHub response exceeds the allowed size.");
  if (!response.body) throw new Error("GitHub returned an empty response.");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      const buffer = Buffer.from(chunk.value);
      total += buffer.length;
      if (total > limit) throw new Error("GitHub response exceeds the allowed size.");
      chunks.push(buffer);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

interface GithubReleaseData {
  tag_name?: unknown;
  name?: unknown;
  target_commitish?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown; state?: unknown }>;
}

/** Prereleases have a dedicated release tag and are only built from the pre-release branch. */
export function selectReleaseByChannel(records: GithubReleaseData[], channel: UpdateChannel): GithubReleaseData | undefined {
  if (channel === "stable") return records.find((release) => release.draft === false && release.prerelease === false);
  return records.find((release) =>
    release.draft === false && release.prerelease === true &&
    typeof release.tag_name === "string" && /^prerelease-[0-9]+-[0-9]+$/.test(release.tag_name),
  );
}

export async function latestGithubRelease(input: string, channel: UpdateChannel = "stable"): Promise<GithubRelease> {
  const repository = validateGithubRepository(input);
  if (channel !== "stable" && channel !== "pre-release") throw new Error("Invalid update channel.");
  const current = await installedReleaseSource();
  const endpoint = channel === "stable" ? "releases/latest" : "releases?per_page=100";
  const response = await fetch("https://api.github.com/repos/" + repository + "/" + endpoint, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "chatgpt-coder" },
    redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "No public " + channel + " release was found for " + repository + "." : "GitHub release request failed (HTTP " + response.status + ").");
  const payload: unknown = JSON.parse((await readLimited(response, MAX_METADATA)).toString("utf8"));
  let data: GithubReleaseData | undefined;
  if (channel === "stable") {
    if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("GitHub returned invalid stable release data.");
    data = payload as GithubReleaseData;
    if (data.prerelease === true || data.draft === true) throw new Error("GitHub returned an unexpected prerelease for the stable channel.");
  } else {
    if (!Array.isArray(payload)) throw new Error("GitHub returned invalid prerelease data.");
    data = selectReleaseByChannel(payload, channel);
    if (!data) throw new Error("No published pre-release build was found. Push a verified build to the pre-release branch first.");
  }
  const tag = data.tag_name;
  if (typeof tag !== "string" || !tag || tag.length > 200 || /[\x00-\x1f]/.test(tag)) throw new Error("GitHub returned an invalid release tag.");
  const asset = Array.isArray(data.assets) ? data.assets.find((item) => item.name === "chatgpt-coder-windows.zip" && item.state === "uploaded") : undefined;
  if (!asset || typeof asset.browser_download_url !== "string" || typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest) || typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ARCHIVE) throw new Error("The selected " + channel + " release has no valid Windows ZIP with a GitHub SHA-256 digest.");
  const url = new URL(asset.browser_download_url);
  const expectedPath = "/" + repository + "/releases/download/" + tag + "/chatgpt-coder-windows.zip";
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || decodeURIComponent(url.pathname).toLowerCase() !== expectedPath.toLowerCase()) throw new Error("GitHub returned an unexpected update download URL.");
  const sha256 = asset.digest.slice(7).toLowerCase();
  const sameRepository = current.repository?.toLowerCase() === repository.toLowerCase();
  const name = typeof data.name === "string" ? data.name.slice(0, 200) : tag;
  const commit = typeof data.target_commitish === "string" && /^[a-f0-9]{40}$/i.test(data.target_commitish) ? data.target_commitish.toLowerCase() : undefined;
  const latestVersion = stableVersion(/^chatgpt-coder\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/i.exec(name)?.[1] ?? "");
  const runningVersion = stableVersion(APP_VERSION);
  const versionDifference = latestVersion && runningVersion ? latestVersion.reduce((difference, part, index) => difference || part - runningVersion[index]!, 0) : undefined;
  const same = sameRepository && (current.sha256 ? current.sha256.toLowerCase() === sha256 : (commit && current.commit?.toLowerCase() === commit) || (current.tag && current.tag === tag));
  const comparison = same ? "current" : versionDifference !== undefined && versionDifference < 0 ? "older" : sameRepository && (current.sha256 || current.tag || current.commit && commit) || versionDifference !== undefined && versionDifference > 0 ? "different" : "unknown";
  return { repository, tag, name, url: "https://github.com/" + repository + "/releases/tag/" + encodeURIComponent(tag), downloadUrl: url.href, sha256, size: asset.size, commit, comparison };
}

async function downloadGithubAsset(initial: string): Promise<Response> {
  let url = new URL(initial);
  const signal = AbortSignal.timeout(180000);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (url.protocol !== "https:" || url.username || url.password || !allowedDownloadHosts.has(url.hostname)) throw new Error("GitHub update redirected to an unexpected host.");
    const response = await fetch(url, { headers: { "User-Agent": "chatgpt-coder" }, redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("GitHub update redirect has no destination.");
      await response.body?.cancel().catch(() => undefined);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`GitHub update download failed (HTTP ${response.status}).`);
    return response;
  }
  throw new Error("Too many GitHub update redirects.");
}

export async function prepareGithubUpdate(release: GithubRelease): Promise<UpdatePackage> {
  const response = await downloadGithubAsset(release.downloadUrl);
  const data = await readLimited(response, MAX_ARCHIVE);
  if (data.length !== release.size || createHash("sha256").update(data).digest("hex") !== release.sha256) throw new Error("Downloaded update does not match GitHub's size and SHA-256 digest.");
  const directory = path.join(harnessHome(), "updates");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `github-${randomUUID()}.zip`);
  try {
    await writeFile(file, data, { flag: "wx", mode: 0o600 });
    const pending = await prepareUpdate(file);
    if (pending.sha256 !== release.sha256) { await discardUpdate(pending); throw new Error("Update changed while preparing it."); }
    pending.source = release.url;
    pending.githubRelease = { repository: release.repository, tag: release.tag, commit: release.commit };
    return pending;
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

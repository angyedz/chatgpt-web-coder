import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { harnessHome } from "../utils/paths.js";

interface ReleaseAsset { name: string; browser_download_url: string; digest?: string | null }

export async function installTunnelClient(report: (message: string) => void = () => undefined): Promise<string> {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
  if (!platform || !arch) throw new Error(`Unsupported tunnel-client platform: ${process.platform}/${process.arch}`);
  report("Fetching the latest tunnel-client release...");
  const response = await fetch("https://api.github.com/repos/openai/tunnel-client/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "chatgpt-coder" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub release request failed: HTTP ${response.status}`);
  const release = await response.json() as { tag_name?: string; assets?: ReleaseAsset[] };
  const asset = (release.assets ?? []).find((item) => item.name.startsWith("tunnel-client-v") && item.name.includes(`${platform}-${arch}`) && item.name.endsWith(".zip"));
  if (!asset) throw new Error(`No tunnel-client release for ${platform}-${arch} (${release.tag_name ?? "unknown version"}).`);
  if (!/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? "")) throw new Error("Tunnel release has no SHA-256 digest; refusing an unverified download.");
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/openai/tunnel-client/releases/download/")) throw new Error("Unexpected tunnel-client download URL.");
  report(`Downloading ${asset.name}...`);
  const download = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!download.ok) throw new Error(`Tunnel download failed: HTTP ${download.status}`);
  const archive = Buffer.from(await download.arrayBuffer());
  if (archive.length > 100_000_000) throw new Error("Tunnel archive exceeds the allowed size.");
  const hash = createHash("sha256").update(archive).digest("hex");
  if (hash.toLowerCase() !== asset.digest!.slice(7).toLowerCase()) throw new Error("Tunnel-client SHA-256 verification failed.");
  const executable = process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
  const entry = new AdmZip(archive).getEntries().find((item) => !item.isDirectory && path.posix.basename(item.entryName.replaceAll("\\", "/")) === executable);
  if (!entry || entry.header.size <= 0 || entry.header.size > 150_000_000) throw new Error(`Archive does not contain a valid ${executable}.`);
  const bin = path.join(harnessHome(), "bin");
  await mkdir(bin, { recursive: true });
  const destination = path.join(bin, executable);
  const temporary = path.join(bin, `.${executable}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, entry.getData(), { mode: 0o755 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  report(`Installed and verified tunnel-client: ${destination}`);
  return destination;
}

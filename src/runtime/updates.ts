import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import AdmZip from "adm-zip";
import { harnessHome, isInside } from "../utils/paths.js";

const MAX_ARCHIVE = 100 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_UNPACKED = 150 * 1024 * 1024;
const UPDATE_PROTOCOL = "# chatgpt-coder update protocol: 1";

interface Installation { root: string; release: string }
export interface UpdatePackage { kind: "package"; version: string; source: string; sha256: string; snapshot: string; installation: Installation; githubRelease?: { repository: string; tag: string; commit?: string } }
export interface UpdateRollback { kind: "rollback"; version: string; targetRelease: string; installation: Installation }
export type PendingUpdate = UpdatePackage | UpdateRollback;

export interface McpRefreshReminder {
  root: string;
  from: string;
  to: string;
  result: "changed" | "unknown";
}

const toolFingerprintScript = `
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const app = process.argv[1];
const { toolDefinitions } = await import(pathToFileURL(path.join(app, 'dist', 'tools', 'index.js')).href);
const { z } = await import(pathToFileURL(path.join(app, 'node_modules', 'zod', 'index.js')).href);
const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
const manifest = toolDefinitions.map(t => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations, inputSchema: z.toJSONSchema(z.object(t.inputSchema), { target: 'draft-7', io: 'input' }) })).sort((a, b) => a.name.localeCompare(b.name));
process.stdout.write(createHash('sha256').update(JSON.stringify(sort(manifest))).digest('hex'));
`;

async function toolFingerprint(root: string, release: string): Promise<string> {
  if (!/^[0-9a-f]{32}$/.test(release)) throw new Error("Invalid release identifier.");
  const app = path.join(root, "releases", release, "app");
  const result = await runChild(process.execPath, ["--input-type=module", "-e", toolFingerprintScript, app], undefined, 15_000);
  const value = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Could not compare MCP tool metadata.");
  return value;
}

function reminderPath(reminder: Pick<McpRefreshReminder, "root" | "from" | "to">): string {
  if (!/^[0-9a-f]{32}$/.test(reminder.from) || !/^[0-9a-f]{32}$/.test(reminder.to)) throw new Error("Invalid release identifier.");
  const installationKey = createHash("sha256").update(path.resolve(reminder.root).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(harnessHome(), "updates", "mcp-refresh", `${installationKey}-${reminder.from}-${reminder.to}.ack`);
}

async function compareMcpTools(root: string, from: string, to: string): Promise<McpRefreshReminder | undefined> {
  if (from === to) return undefined;
  const reminder: McpRefreshReminder = { root, from, to, result: "unknown" };
  try { if ((await readFile(reminderPath(reminder), "utf8")) === "dismissed") return undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    const [before, after] = await Promise.all([toolFingerprint(root, from), toolFingerprint(root, to)]);
    if (before === after) return undefined;
    reminder.result = "changed";
  } catch { /* An unknown comparison must not be presented as a confirmed change. */ }
  return reminder;
}

export async function mcpRefreshAfterUpdate(pending: PendingUpdate): Promise<McpRefreshReminder | undefined> {
  const { root, release: from } = pending.installation;
  const to = (await readFile(path.join(root, "current.txt"), "utf8")).trim();
  if (!/^[0-9a-f]{32}$/.test(to)) throw new Error("Invalid installed release identifier.");
  return compareMcpTools(root, from, to);
}

export async function mcpRefreshOnStartup(): Promise<McpRefreshReminder | undefined> {
  const current = await installation();
  const file = path.join(current.root, "releases", current.release, "release.json");
  const metadata = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as { previous?: unknown };
  if (typeof metadata.previous !== "string" || !/^[0-9a-f]{32}$/.test(metadata.previous)) return undefined;
  return compareMcpTools(current.root, metadata.previous, current.release);
}

export async function dismissMcpRefresh(reminder: McpRefreshReminder): Promise<void> {
  const file = reminderPath(reminder);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, "dismissed", { encoding: "utf8", mode: 0o600 });
}

async function installation(): Promise<Installation> {
  if (process.platform !== "win32") throw new Error("Local update files are supported by the Windows installation.");
  const root = process.env.CHATGPT_CODER_INSTALL_DIR;
  const release = process.env.CHATGPT_CODER_RELEASE_ID;
  if (!root || !release || !/^[0-9a-f]{32}$/.test(release)) throw new Error("This instance was not started by the installed launcher. Install the latest Windows setup first.");
  const resolvedRoot = await realpath(root);
  const runtime = await realpath(path.join(resolvedRoot, "releases", release, "runtime", "node.exe"));
  const currentRuntime = await realpath(process.execPath);
  if (runtime.toLowerCase() !== currentRuntime.toLowerCase()) throw new Error("Installed runtime does not match the active application.");
  const marker = (await readFile(path.join(resolvedRoot, "current.txt"), "utf8")).trim();
  if (marker !== release) throw new Error("The installed version has already changed. Restart chatgpt-coder before updating again.");
  return { root: resolvedRoot, release };
}

export async function checkUpdateAvailability(): Promise<void> { await installation(); }

export async function installedReleaseSource(): Promise<{ repository?: string; tag?: string; commit?: string; sha256?: string }> {
  const current = await installation();
  const data = JSON.parse((await readFile(path.join(current.root, "releases", current.release, "release.json"), "utf8")).replace(/^\uFEFF/, "")) as { repository?: unknown; tag?: unknown; commit?: unknown; sha256?: unknown };
  return {
    repository: typeof data.repository === "string" ? data.repository : undefined,
    tag: typeof data.tag === "string" ? data.tag : undefined,
    commit: typeof data.commit === "string" ? data.commit : undefined,
    sha256: typeof data.sha256 === "string" ? data.sha256 : undefined,
  };
}

function digest(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

function inspectArchive(data: Buffer): { version: string; entries: AdmZip.IZipEntry[] } {
  if (data.length < 4 || data.length > MAX_ARCHIVE || data.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP file or archive exceeds 100 MB.");
  const entries = new AdmZip(data).getEntries();
  if (entries.length > 3000) throw new Error("Update archive contains too many entries.");
  const names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName.replaceAll("\\", "/");
    const parts = name.split("/").filter(Boolean);
    if (!parts.length || name.startsWith("/") || parts.some((part) => part === "." || part === ".." || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe path in update archive: ${name}`);
    const canonical = parts.join("/").toLowerCase();
    if (names.has(canonical)) throw new Error(`Duplicate path in update archive: ${name}`);
    names.add(canonical);
    const unixType = (entry.header.attr >>> 16) & 0o170000;
    if (unixType === 0o120000 || entry.header.encrypted) throw new Error("Symbolic links and encrypted entries are not accepted.");
    if (entry.header.size > MAX_FILE || entry.header.compressedSize > MAX_ARCHIVE) throw new Error(`Update entry is too large: ${name}`);
    total += entry.header.size;
    if (total > MAX_UNPACKED) throw new Error("Unpacked update exceeds 150 MB.");
  }
  const find = (name: string) => entries.find((entry) => entry.entryName.replaceAll("\\", "/").toLowerCase() === name.toLowerCase() && !entry.isDirectory);
  for (const required of ["package.json", "package-lock.json", "tsconfig.json", "src/index.tsx", "scripts/install-windows.ps1", "scripts/windows-launcher.cs"]) {
    if (!find(required)) throw new Error(`Update archive is missing ${required}.`);
  }
  const info: unknown = JSON.parse(find("package.json")!.getData().toString("utf8"));
  const lock: unknown = JSON.parse(find("package-lock.json")!.getData().toString("utf8"));
  if (!info || typeof info !== "object" || (info as { name?: unknown }).name !== "chatgpt-coder" || typeof (info as { version?: unknown }).version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test((info as { version: string }).version)) throw new Error("Invalid chatgpt-coder package metadata.");
  if (!lock || typeof lock !== "object" || (lock as { name?: unknown }).name !== "chatgpt-coder" || (lock as { version?: unknown }).version !== (info as { version: string }).version) throw new Error("Package and lock file versions do not match.");
  if (!find("scripts/install-windows.ps1")!.getData().toString("utf8").includes(UPDATE_PROTOCOL)) throw new Error("This archive does not support in-app updates. Reinstall from a newer setup package first.");
  return { version: (info as { version: string }).version, entries };
}

export async function chooseUpdateFile(): Promise<string | undefined> {
  if (process.platform !== "win32") throw new Error("The update file chooser is available on Windows.");
  const script = `$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Show()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select chatgpt-coder update ZIP'; $dialog.Filter = 'ZIP files (*.zip)|*.zip'; $dialog.CheckFileExists = $true
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }
$dialog.Dispose(); $owner.Dispose()`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await runChild("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded]);
  if (result.code !== 0) throw new Error(`Could not open the file chooser: ${result.output.slice(-1500)}`);
  return result.stdout.trim() || undefined;
}

export async function prepareUpdate(source: string): Promise<UpdatePackage> {
  const target = await installation();
  const file = path.resolve(source.trim().replace(/^(["'])([\s\S]*)\1$/, "$2"));
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_ARCHIVE || path.extname(file).toLowerCase() !== ".zip") throw new Error("Choose a ZIP file no larger than 100 MB.");
  const dir = path.join(harnessHome(), "updates");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const snapshot = path.join(dir, `${randomUUID()}.zip`);
  try {
    await copyFile(file, snapshot, constants.COPYFILE_EXCL);
    if ((await stat(snapshot)).size > MAX_ARCHIVE) throw new Error("The update archive grew beyond 100 MB while it was copied.");
    const data = await readFile(snapshot);
    const archive = inspectArchive(data);
    return { kind: "package", version: archive.version, source: file, sha256: digest(data), snapshot, installation: target };
  } catch (error) {
    await unlink(snapshot).catch(() => undefined);
    throw error;
  }
}

export async function prepareRollback(): Promise<UpdateRollback> {
  const target = await installation();
  let metadata: { previous?: unknown };
  try {
    metadata = JSON.parse((await readFile(path.join(target.root, "releases", target.release, "release.json"), "utf8")).replace(/^\uFEFF/, "")) as { previous?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No previous release is recorded for this installation.");
    throw error;
  }
  if (typeof metadata.previous !== "string" || !/^[0-9a-f]{32}$/.test(metadata.previous) || metadata.previous === target.release) throw new Error("No previous release is recorded for this installation.");
  const previous = path.join(target.root, "releases", metadata.previous);
  const packageData = JSON.parse(await readFile(path.join(previous, "app", "package.json"), "utf8")) as { name?: string; version?: string };
  if (packageData.name !== "chatgpt-coder" || typeof packageData.version !== "string") throw new Error("The previous release metadata is invalid.");
  await stat(path.join(previous, "runtime", "node.exe"));
  await stat(path.join(previous, "app", "dist", "index.js"));
  return { kind: "rollback", version: packageData.version, targetRelease: metadata.previous, installation: target };
}

export async function discardUpdate(pending: PendingUpdate | undefined): Promise<void> {
  if (pending?.kind === "package") await unlink(pending.snapshot).catch(() => undefined);
}

export async function updateLog(): Promise<string> {
  try { return await readFile(path.join(harnessHome(), "updates", "update.log"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No update log is available.";
    throw error;
  }
}

export async function applyUpdate(pending: PendingUpdate, report: (message: string) => void): Promise<void> {
  const current = await installation();
  if (current.root.toLowerCase() !== pending.installation.root.toLowerCase() || current.release !== pending.installation.release) throw new Error("Installation changed since the update was selected. Restart and select it again.");
  const lockPath = path.join(current.root, ".update.lock");
  const token = randomUUID();
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`An update lock already exists: ${lockPath}. If no update is running, remove that file manually.`);
    throw error;
  }
  try {
    await lock.writeFile(`${token}\n${process.pid}\n`);
    await lock.close();
    if (pending.kind === "rollback") {
      const verified = await prepareRollback();
      if (verified.targetRelease !== pending.targetRelease || verified.version !== pending.version) throw new Error("The rollback target changed after review. Select it again.");
      const marker = path.join(current.root, "current.txt");
      const temp = path.join(current.root, `.rollback-${token}.tmp`);
      try {
        await writeFile(temp, pending.targetRelease, { flag: "wx", encoding: "ascii" });
        if ((await readFile(marker, "utf8")).trim() !== current.release) throw new Error("The installed version changed during rollback.");
        await rename(temp, marker);
      } finally { await unlink(temp).catch(() => undefined); }
      return;
    }
    const data = await readFile(pending.snapshot);
    if (digest(data) !== pending.sha256) throw new Error("The selected update changed after review. Select it again.");
    const archive = inspectArchive(data);
    if (archive.version !== pending.version) throw new Error("The update version changed after review.");
    const source = path.join(harnessHome(), "updates", `source-${randomUUID()}`);
    await mkdir(source, { recursive: false, mode: 0o700 });
    try {
      for (const entry of archive.entries) {
        if (entry.isDirectory) continue;
        const name = entry.entryName.replaceAll("\\", "/");
        if (!/^(?:src\/|prebuilt\/|scripts\/(?:install-windows\.ps1|windows-launcher\.cs)$|package(?:-lock)?\.json$|tsconfig\.json$)/i.test(name)) continue;
        const destination = path.resolve(source, ...name.split("/"));
        if (!isInside(source, destination)) throw new Error("Update entry escapes the staging directory.");
        await mkdir(path.dirname(destination), { recursive: true });
        const content = entry.getData();
        if (content.length !== entry.header.size) throw new Error(`Invalid extracted size: ${name}`);
        await writeFile(destination, content, { flag: "wx", mode: 0o600 });
      }
      report("Preparing the new release. The existing version remains active until the installer succeeds.");
      const result = await runChild("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(source, "scripts", "install-windows.ps1"), "-Update", "-InstallDir", current.root, "-SourceRoot", source, "-ExpectedCurrentRelease", current.release], report);
      await writeFile(path.join(harnessHome(), "updates", "update.log"), result.output, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
      if (result.code !== 0) throw new Error(`Update installer exited with code ${result.code}. Previous release remains selected unless the installer changed it. Details: ${result.output.slice(-2500)}`);
      const marker = (await readFile(path.join(current.root, "current.txt"), "utf8")).trim();
      if (!/^[0-9a-f]{32}$/.test(marker) || marker === current.release) throw new Error("Installer did not activate a new release. Check its output.");
      if (pending.githubRelease) {
        const metadataPath = path.join(current.root, "releases", marker, "release.json");
        const metadataTemp = `${metadataPath}.${token}.tmp`;
        try {
          const metadata = JSON.parse((await readFile(metadataPath, "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>;
          Object.assign(metadata, pending.githubRelease, { sha256: pending.sha256 });
          await writeFile(metadataTemp, JSON.stringify(metadata), { encoding: "utf8", flag: "wx" });
          await rename(metadataTemp, metadataPath);
        } catch {
          report("Update installed, but its GitHub release identity could not be recorded. Future checks may show an unknown installed build.");
        } finally { await unlink(metadataTemp).catch(() => undefined); }
      }
      await discardUpdate(pending);
    } finally {
      await cleanupStaging(source).catch(() => undefined);
    }
  } finally {
    await lock.close().catch(() => undefined);
    const contents = await readFile(lockPath, "utf8").catch(() => "");
    if (contents.startsWith(`${token}\n`)) await unlink(lockPath).catch(() => undefined);
  }
}

async function cleanupStaging(source: string): Promise<void> {
  const updates = await realpath(path.join(harnessHome(), "updates"));
  const info = await lstat(source);
  const resolved = await realpath(source);
  const expected = /^source-[0-9a-f-]{36}$/i.test(path.basename(source));
  if (!expected || !info.isDirectory() || info.isSymbolicLink() || path.dirname(resolved).toLowerCase() !== updates.toLowerCase() || resolved.toLowerCase() !== path.resolve(source).toLowerCase()) return;
  await rm(resolved, { recursive: true, force: true });
}

async function runChild(executable: string, args: string[], report?: (message: string) => void, timeout?: number): Promise<{ code: number | null; output: string; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout });
    let output = "";
    let stdoutText = "";
    let stderrText = "";
    const stdout = new StringDecoder("utf8");
    const stderr = new StringDecoder("utf8");
    const pendingLines = { stdout: "", stderr: "" };
    const reportLines = (text: string, stream: "stdout" | "stderr", flush = false) => {
      const lines = (pendingLines[stream] + text).split(/\r?\n/);
      pendingLines[stream] = flush ? "" : (lines.pop() ?? "");
      if (flush && lines.length === 0 && !text) return;
      for (const line of lines) {
        if (report && /\[\d\/\d\]|\[cleanup\]|Update installed|cleanup.*skipped|failed|error/i.test(line)) report(line.trim().slice(-300));
      }
    };
    const record = (decoder: StringDecoder, chunk: Buffer, stream: "stdout" | "stderr") => {
      const text = decoder.write(chunk);
      output = (output + text).slice(-40_000);
      if (stream === "stdout") stdoutText = (stdoutText + text).slice(-40_000);
      else stderrText = (stderrText + text).slice(-40_000);
      reportLines(text, stream);
    };
    child.stdout.on("data", (chunk: Buffer) => record(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => record(stderr, chunk, "stderr"));
    child.once("error", reject);
    child.once("close", (code) => {
      const stdoutEnd = stdout.end();
      const stderrEnd = stderr.end();
      reportLines(stdoutEnd, "stdout", true);
      reportLines(stderrEnd, "stderr", true);
      resolve({ code, output: output + stdoutEnd + stderrEnd, stdout: stdoutText + stdoutEnd, stderr: stderrText + stderrEnd });
    });
  });
}

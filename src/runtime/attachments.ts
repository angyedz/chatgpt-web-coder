import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvents } from "../events.js";
import { expandHome, harnessHome, isInside, resolveInside } from "../utils/paths.js";

export interface Attachment {
  id: string;
  kind: "file" | "directory" | "text";
  name: string;
  path: string;
  size?: number;
  pending: boolean;
}

// A terminal sends a dropped file as a path, not a drag-and-drop event.
export function imagePathFromPaste(value: string): string | undefined {
  let raw = value.trim();
  if (raw.startsWith("& ")) raw = raw.slice(2).trim();
  if (/^(["'])[\s\S]*\1$/.test(raw)) raw = raw.slice(1, -1);
  if (/^file:\/\//i.test(raw)) {
    try { raw = fileURLToPath(raw); } catch { return undefined; }
  }
  if (!(path.isAbsolute(raw) || path.win32.isAbsolute(raw)) || !/\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i.test(raw)) return undefined;
  return raw;
}

export async function readWindowsClipboardText(): Promise<string> {
  if (process.platform !== "win32") return "";
  const script = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsText()) { [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText()) }";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Could not read clipboard text (exit ${code}).`)));
  });
}

export class AttachmentStore {
  private items: Attachment[] = [];
  private sessionId = "";
  constructor(private readonly events: HarnessEvents) {}
  get current(): Attachment[] { return this.items.map((item) => ({ ...item })); }
  get pending(): Attachment[] { return this.current.filter((item) => item.pending); }
  restore(sessionId: string, items: Attachment[] = []): void {
    this.sessionId = sessionId;
    this.items = items.filter((item) => item && /^att_[0-9a-f-]{36}$/i.test(item.id) && ["file", "directory", "text"].includes(item.kind) && typeof item.path === "string" && typeof item.name === "string").map((item) => ({ ...item, pending: Boolean(item.pending) && item.kind !== "text" }));
    this.emit();
  }
  async attach(input: string, workspace: string): Promise<Attachment> {
    const sessionId = this.sessionId;
    const raw = input.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
    if (!raw) throw new Error("Choose a file or folder to attach.");
    const absolute = await realpath(path.resolve(workspace, expandHome(raw)));
    const info = await stat(absolute);
    if (this.sessionId !== sessionId) throw new Error("Session changed while attaching the file. Attach it again.");
    if (!info.isFile() && !info.isDirectory()) throw new Error("Only regular files and folders can be attached.");
    if (info.isFile() && info.size > 50 * 1024 * 1024) throw new Error("A file attachment cannot exceed 50 MB.");
    if (this.pending.filter((item) => item.kind === "file").length >= 10 && info.isFile()) throw new Error("At most 10 files may be attached to one message.");
    const existing = this.items.find((item) => item.path === absolute && item.pending);
    if (existing) return { ...existing };
    const name = path.basename(absolute) || absolute;
    if (info.isFile() && this.pending.some((item) => item.kind === "file" && item.name.toLowerCase() === name.toLowerCase())) throw new Error("Pending files must have distinct names.");
    const item: Attachment = { id: `att_${randomUUID()}`, kind: info.isDirectory() ? "directory" : "file", name, path: absolute, ...(info.isFile() ? { size: info.size } : {}), pending: true };
    this.items.push(item);
    this.emit();
    return { ...item };
  }
  async saveText(value: string): Promise<Attachment> {
    if (!this.sessionId) throw new Error("The local session is not ready.");
    const dir = path.join(harnessHome(), "attachments", this.sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = `att_${randomUUID()}`;
    const file = path.join(dir, `${id}.txt`);
    await writeFile(file, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const item: Attachment = { id, kind: "text", name: `${id}.txt`, path: file, size: Buffer.byteLength(value, "utf8"), pending: false };
    this.items.push(item);
    this.emit();
    return { ...item };
  }
  async attachClipboardImage(): Promise<Attachment> {
    if (process.platform !== "win32") throw new Error("Clipboard images are currently supported on Windows. Use /attach <image path> instead.");
    if (!this.sessionId) throw new Error("The local session is not ready.");
    const sessionId = this.sessionId;
    const dir = path.join(harnessHome(), "attachments", sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `clipboard-${randomUUID()}.png`);
    const script = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 2 }; $image=[System.Windows.Forms.Clipboard]::GetImage(); if (-not $image) { exit 2 }; try { $image.Save($env:CHATGPT_CODER_CLIPBOARD_IMAGE, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }";
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore", env: { ...process.env, CHATGPT_CODER_CLIPBOARD_IMAGE: file } });
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) { await unlink(file).catch(() => undefined); throw new Error(code === 2 ? "There is no image in the clipboard." : `Could not read the clipboard image (exit ${code}).`); }
    try {
      if (this.sessionId !== sessionId) throw new Error("Session changed while reading the clipboard. Paste the image again.");
      return await this.attach(file, dir);
    }
    catch (error) { await unlink(file).catch(() => undefined); throw error; }
  }
  remove(id: string): boolean {
    const index = this.items.findIndex((item) => item.id === id || item.id.startsWith(id));
    if (index < 0 || this.items.filter((item) => item.id === id || item.id.startsWith(id)).length !== 1) return false;
    this.items.splice(index, 1);
    this.emit();
    return true;
  }
  clearPending(): void { this.items = this.items.filter((item) => !item.pending); this.emit(); }
  markSent(ids: string[]): void {
    this.items = this.items.map((item) => ids.includes(item.id) && item.kind === "file" ? { ...item, pending: false } : item);
    this.emit();
  }
  async resolve(id: string, relative?: string): Promise<{ item: Attachment; file: string }> {
    const matches = this.items.filter((item) => item.id === id || item.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? "Attachment ID is ambiguous." : "Attachment not found in this session.");
    const item = matches[0]!;
    if (item.kind === "text") {
      const expected = path.resolve(harnessHome(), "attachments", this.sessionId, `${item.id}.txt`);
      const actual = await realpath(expected);
      if (path.resolve(item.path) !== expected || !isInside(path.dirname(expected), actual)) throw new Error("Invalid saved-text attachment path.");
      return { item, file: actual };
    }
    const actual = await realpath(item.path);
    if (actual !== item.path) throw new Error("Attachment path changed since it was selected. Detach and add it again.");
    if (item.kind === "directory") return { item, file: resolveInside(actual, relative || ".") };
    if (relative && relative !== ".") throw new Error("A file attachment does not contain paths.");
    return { item, file: actual };
  }
  private emit(): void { this.events.emit({ type: "attachments", attachments: this.current }); }
}

export async function chooseAttachment(kind: "file" | "directory"): Promise<string | undefined> {
  if (process.platform !== "win32") throw new Error("The picker is available on Windows. Use /attach <path> on this platform.");
  const dialog = kind === "directory"
    ? "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select a folder to attach'; if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"
    : "$dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = 'Select a file or image to attach'; $dialog.Filter = 'All files (*.*)|*.*'; $dialog.CheckFileExists = $true; if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }";
  const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; Add-Type -AssemblyName System.Windows.Forms; $owner=New-Object System.Windows.Forms.Form; $owner.TopMost=$true; $owner.ShowInTaskbar=$false; $owner.StartPosition='Manual'; $owner.Location=New-Object System.Drawing.Point(-32000,-32000); $owner.Show(); ${dialog}; $dialog.Dispose(); $owner.Dispose()`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => { output += part; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output.trim() || undefined) : reject(new Error(`File picker exited with code ${code}.`)));
  });
}

// Offset is in UTF-8 bytes. Do not cut a multi-byte character at a chunk edge.
export async function readAttachmentChunk(file: string, offset: number, limit: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Attachment is not a regular file.");
    if (offset > info.size) throw new Error("Offset is past the end of the file.");
    const data = Buffer.alloc(Math.min(limit + 4, info.size - offset));
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const result = await handle.read(data, bytesRead, data.length - bytesRead, offset + bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead && (data[0]! & 0xc0) === 0x80) throw new Error("Offset must be at a UTF-8 character boundary; use next_offset from the previous result.");
    let end = Math.min(limit, bytesRead);
    while (end < bytesRead && end > 0 && (data[end]! & 0xc0) === 0x80) end -= 1;
    const bytes = data.subarray(0, end);
    if (bytes.includes(0)) throw new Error("This attachment appears to be binary. Use view_image for images.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("Attachment is not valid UTF-8 text."); }
    return `bytes ${offset}-${offset + end} of ${info.size}${offset + end < info.size ? `; next_offset=${offset + end}` : "; end of file"}\n\n${content}`;
  } finally { await handle.close(); }
}

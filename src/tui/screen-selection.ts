import { spawn } from "node:child_process";
import xterm from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import stringWidth from "string-width";

interface Point { x: number; y: number }
interface Selection { start: Point; end: Point }
export interface SelectableTextRow { y: number; startColumn: number; text: string }

// Ink does not expose its rendered cells. Mirror output for selection
// highlighting, while copying from the transcript's semantic message rows.
export class ScreenSelection {
  private terminal: InstanceType<typeof xterm.Terminal>;
  private originalWrite: typeof process.stdout.write;
  private selected?: Selection;
  private selectableRows = new Map<number, SelectableTextRow>();
  private writeVersion = 0;
  private readonly resize: () => void;
  private closed = false;

  constructor(private readonly stdout: NodeJS.WriteStream) {
    this.terminal = new xterm.Terminal({ cols: stdout.columns || 80, rows: stdout.rows || 24, allowProposedApi: true, scrollback: 0 });
    this.originalWrite = stdout.write;
    const original = this.originalWrite.bind(stdout);
    const self = this;
    stdout.write = function (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
      if (!self.closed) {
        const version = ++self.writeVersion;
        self.terminal.write(typeof chunk === "string" ? chunk : new Uint8Array(chunk), () => {
          if (self.selected && !self.closed && version === self.writeVersion) self.paint(self.selected);
        });
      }
      return original(chunk as never, encodingOrCallback as never, callback as never);
    } as typeof stdout.write;
    this.resize = () => {
      this.clear();
      this.terminal.resize(Math.max(1, stdout.columns || 80), Math.max(1, stdout.rows || 24));
    };
    stdout.on("resize", this.resize);
  }

  private clamp(point: Point): Point {
    return { x: Math.max(0, Math.min(this.terminal.cols - 1, point.x - 1)), y: Math.max(0, Math.min(this.terminal.rows - 1, point.y - 1)) };
  }
  setSelectableRows(rows: SelectableTextRow[]): void {
    if (rows.length === this.selectableRows.size && rows.every((row) => {
      const existing = this.selectableRows.get(row.y);
      return existing?.startColumn === row.startColumn && existing.text === row.text;
    })) return;
    this.clear();
    this.selectableRows = new Map(rows.map((row) => [row.y, row]));
  }
  start(point: Point): boolean {
    this.clear();
    const p = this.clamp(point);
    const row = this.selectableRows.get(p.y);
    if (!row || p.x < row.startColumn || p.x >= row.startColumn + stringWidth(row.text)) return false;
    this.selected = { start: p, end: p };
    return true;
  }
  move(point: Point): void {
    if (!this.selected) return;
    const previous = this.selected;
    this.selected = { start: previous.start, end: this.clamp(point) };
    this.paint(previous, true);
    this.paint(this.selected);
  }
  end(point: Point): string {
    if (!this.selected) return "";
    this.move(point);
    const { start, end } = this.ordered(this.selected);
    if (start.x === end.x && start.y === end.y) { this.clear(); return ""; }
    const lines: string[] = [];
    for (let y = start.y; y <= end.y; y++) {
      const row = this.selectableRows.get(y);
      if (!row) continue;
      const first = Math.max(row.startColumn, y === start.y ? start.x : row.startColumn);
      const last = Math.min(row.startColumn + stringWidth(row.text) - 1, y === end.y ? end.x : this.terminal.cols - 1);
      if (first > last) continue;
      const text = sliceByColumns(row.text, first - row.startColumn, last - row.startColumn + 1);
      if (text) lines.push(text);
    }
    this.clear();
    return lines.join("\n");
  }
  clear(): void {
    const old = this.selected;
    this.selected = undefined;
    if (old) this.paint(old, true);
  }
  dispose(): void {
    this.clear();
    this.closed = true;
    this.stdout.off("resize", this.resize);
    this.stdout.write = this.originalWrite;
    this.terminal.dispose();
  }
  private ordered(selection: Selection): Selection {
    const { start, end } = selection;
    return start.y < end.y || (start.y === end.y && start.x <= end.x) ? selection : { start: end, end: start };
  }
  private paint(selection: Selection, restore = false): void {
    const { start, end } = this.ordered(selection);
    let output = "\u001b7\u001b[?7l";
    for (let y = start.y; y <= end.y; y++) {
      const selectable = this.selectableRows.get(y);
      if (!selectable) continue;
      const line = this.terminal.buffer.active.getLine(this.terminal.buffer.active.viewportY + y);
      if (!line) continue;
      let first = Math.max(selectable.startColumn, y === start.y ? start.x : selectable.startColumn);
      let last = Math.min(selectable.startColumn + stringWidth(selectable.text) - 1, y === end.y ? end.x : this.terminal.cols - 1);
      if (first > last) continue;
      if (line.getCell(first)?.getWidth() === 0 && first > selectable.startColumn) first--;
      if (line.getCell(last)?.getWidth() === 0 && last > first) last--;
      output += `\u001b[${y + 1};${first + 1}H`;
      let previousStyle = "";
      for (let x = first; x <= last; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const style = cellStyle(cell, !restore);
        if (style !== previousStyle) { output += style; previousStyle = style; }
        output += cell.getChars() || " ";
      }
    }
    output += "\u001b[0m\u001b[?7h\u001b8";
    this.originalWrite.call(this.stdout, output);
  }
}

function sliceByColumns(text: string, start: number, end: number): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let column = 0;
  let result = "";
  for (const { segment } of segmenter.segment(text)) {
    const width = stringWidth(segment);
    if (width > 0 && column < end && column + width > start) result += segment;
    column += width;
  }
  return result;
}

function cellStyle(cell: IBufferCell, selected: boolean): string {
  const parts = ["0"];
  if (cell.isBold()) parts.push("1");
  if (cell.isDim()) parts.push("2");
  if (cell.isItalic()) parts.push("3");
  if (cell.isUnderline()) parts.push("4");
  if (Boolean(cell.isInverse()) !== selected) parts.push("7");
  if (cell.isStrikethrough()) parts.push("9");
  for (const foreground of [true, false]) {
    const color = foreground ? cell.getFgColor() : cell.getBgColor();
    if (foreground ? cell.isFgRGB() : cell.isBgRGB()) parts.push(`${foreground ? 38 : 48};2;${color >> 16 & 255};${color >> 8 & 255};${color & 255}`);
    else if (foreground ? cell.isFgPalette() : cell.isBgPalette()) parts.push(`${foreground ? 38 : 48};5;${color}`);
  }
  return `\u001b[${parts.join(";")}m`;
}

export async function copySelection(text: string, stdout: NodeJS.WriteStream): Promise<void> {
  if (process.platform !== "win32") {
    stdout.write(`\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`);
    return;
  }
  const script = "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { error = (error + chunk).slice(-1000); });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `Clipboard process exited with code ${code}`)));
    child.stdin.end(Buffer.from(text, "utf8"));
  });
}

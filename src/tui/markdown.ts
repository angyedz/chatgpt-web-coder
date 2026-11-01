import wrapAnsi from "wrap-ansi";
import stringWidth from "string-width";
import { terminalText } from "./terminal-text.js";

export interface DisplayLine {
  text: string;
  tone?: "heading" | "code" | "muted" | "normal";
  bold?: boolean;
}

// Converts common Markdown into readable terminal lines before measuring the
// viewport. Keep code verbatim, including indentation and blank lines.
export function markdownLines(markdown: string, width: number): DisplayLine[] {
  const result: DisplayLine[] = [];
  let inCode = false;
  let fenceLength = 0;
  let fenceChar = "";
  const columns = Math.max(1, width);
  const source = terminalText(markdown).split("\n");
  for (let lineIndex = 0; lineIndex < source.length; lineIndex++) {
    const raw = source[lineIndex]!;
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (!inCode) {
        fenceLength = fence[1]!.length;
        fenceChar = fence[1]![0]!;
        const language = fence[2]?.trim();
        result.push({ text: language ? `┌─ ${language}` : "┌─ code", tone: "muted" });
      } else if (fence[1]![0] === fenceChar && fence[1]!.length >= fenceLength && !fence[2]?.trim()) {
        result.push({ text: "└─", tone: "muted" });
      } else {
        result.push({ text: `│ ${raw}`, tone: "code" });
        continue;
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      for (const line of wrapAnsi(raw || " ", Math.max(1, columns - 2), { hard: true, trim: false }).split("\n")) {
        result.push({ text: `│ ${line}`, tone: "code" });
      }
      continue;
    }
    const header = parseTableRow(raw);
    const separator = lineIndex + 1 < source.length ? parseTableRow(source[lineIndex + 1]!) : undefined;
    if (header && separator && header.length === separator.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const tableRows: string[][] = [];
      lineIndex++;
      while (lineIndex + 1 < source.length) {
        const row = parseTableRow(source[lineIndex + 1]!);
        if (!row) break;
        tableRows.push(row);
        lineIndex++;
      }
      result.push(...renderTable(header, separator, tableRows, columns));
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
    // ChatGPT sometimes escapes the period in ordered-list markers (`1\.`).
    // Treat that form like a normal Markdown list marker instead of showing
    // the backslash literally in the terminal.
    const list = !heading ? /^(\s*)([-*+]|\d+(?:\\\.|[.)]))\s+(.+)$/.exec(raw) : null;
    const quote = !heading && !list ? /^\s*>\s?(.*)$/.exec(raw) : null;
    const marker = list?.[2]?.replace("\\.", ".");
    let prefix = list ? `${list[1]}${/^\d/.test(marker!) ? marker : "•"} ` : quote ? "│ " : "";
    // Leave room for at least one character in narrow terminals.
    if (prefix.length >= columns) prefix = "";
    const text = renderInline(heading ? heading[1]! : list ? list[3]! : quote ? quote[1]! : raw);
    const wrapped = wrapAnsi(text || " ", Math.max(1, columns - prefix.length), { hard: true, trim: false }).split("\n");
    for (const [index, line] of wrapped.entries()) {
      result.push({ text: `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`, tone: heading ? "heading" : "normal", bold: Boolean(heading) });
    }
  }
  return result;
}

function renderInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => label === url ? url : `${label} (${url})`)
    .replace(/\*\*([^*]+)\*\*/g, "\u001b[1m$1\u001b[22m")
    .replace(/__([^_]+)__/g, "\u001b[1m$1\u001b[22m")
    .replace(/~~([^~]+)~~/g, "\u001b[9m$1\u001b[29m")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "\u001b[3m$1\u001b[23m")
    .replace(/`([^`]+)`/g, "\u001b[36m$1\u001b[39m");
}

function parseTableRow(value: string): string[] | undefined {
  let text = value.trim();
  if (!text.includes("|")) return undefined;
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !/(?<!\\)\\(?:\\\\)*\|$/.test(text)) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "", codeTicks = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length) { cell += char + text[++index]!; continue; }
    if (char === "`") {
      let count = 1;
      while (text[index + count] === "`") count++;
      if (!codeTicks) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      cell += "`".repeat(count);
      index += count - 1;
    } else if (char === "|" && !codeTicks) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function renderTable(header: string[], alignment: string[], rows: string[][], columns: number): DisplayLine[] {
  const count = rows.reduce((max, row) => Math.max(max, row.length), header.length);
  const hasHeader = header.some((cell) => cell.trim());
  const data = hasHeader ? [header, ...rows] : rows;
  const formatted = data.map((row) => Array.from({ length: count }, (_, index) => renderInline((row[index] ?? "").replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"))));
  const natural = Array<number>(count).fill(1);
  for (const row of formatted) for (let index = 0; index < count; index++) {
    for (const part of row[index]!.split("\n")) natural[index] = Math.max(natural[index]!, Math.min(columns, stringWidth(part)));
  }
  const gap = 3 * Math.max(0, count - 1);
  const minWidth = 4;
  if (columns < count * minWidth + gap) {
    const output: DisplayLine[] = [];
    rows.forEach((row, rowIndex) => {
      if (rowIndex) output.push({ text: " " });
      for (let index = 0; index < count; index++) {
        let label = hasHeader && header[index]?.trim() ? `${renderInline(header[index]!.replace(/\\\|/g, "|"))}: ` : index === 0 ? "• " : "  ";
        const value = renderInline((row[index] ?? "").replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"));
        if (stringWidth(label) >= columns - 1) {
          for (const part of wrapAnsi(label.trim(), columns, { hard: true, trim: true }).split("\n")) output.push({ text: part, tone: "heading", bold: true });
          label = columns > 2 ? "  " : "";
        }
        const available = Math.max(1, columns - stringWidth(label));
        const parts = wrapAnsi(value || " ", available, { hard: true, trim: true }).split("\n");
        parts.forEach((part, partIndex) => output.push({ text: `${partIndex ? " ".repeat(Math.min(columns - 1, stringWidth(label))) : label}${part}`, tone: "normal" }));
      }
    });
    if (!rows.length && hasHeader) for (const line of wrapAnsi(header.map(renderInline).join(" · "), columns, { hard: true, trim: true }).split("\n")) output.push({ text: line, tone: "heading", bold: true });
    return output;
  }
  const widths = natural.map((value) => Math.max(minWidth, value));
  while (widths.reduce((sum, width) => sum + width, gap) > columns) {
    const largest = Math.max(...widths);
    if (largest <= minWidth) break;
    widths[widths.indexOf(largest)]!--;
  }
  const output: DisplayLine[] = [];
  formatted.forEach((row, rowIndex) => {
    const cells = row.map((cell, index) => wrapAnsi(cell || " ", widths[index]!, { hard: true, trim: true }).split("\n"));
    const height = Math.max(1, ...cells.map((cell) => cell.length));
    for (let line = 0; line < height; line++) {
      const values = cells.map((cell, index) => {
        const value = cell[line] ?? "";
        const pad = Math.max(0, widths[index]! - stringWidth(value));
        const align = alignment[index] ?? "";
        const left = align.endsWith(":") ? align.startsWith(":") ? Math.floor(pad / 2) : pad : 0;
        return `${" ".repeat(left)}${value}${" ".repeat(pad - left)}`;
      });
      output.push({ text: values.join(" │ ").trimEnd(), tone: hasHeader && rowIndex === 0 ? "heading" : "normal", bold: hasHeader && rowIndex === 0 });
    }
    if (hasHeader && rowIndex === 0 && rows.length) output.push({ text: widths.map((width) => "─".repeat(width)).join("─┼─"), tone: "muted" });
  });
  return output;
}

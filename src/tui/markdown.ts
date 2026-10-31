import wrapAnsi from "wrap-ansi";
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
  const columns = Math.max(1, width);
  for (const raw of terminalText(markdown).split("\n")) {
    const fence = /^\s*```([^`]*)$/.exec(raw);
    if (fence) {
      if (!inCode) {
        const language = fence[1]?.trim();
        result.push({ text: language ? `┌─ ${language}` : "┌─ code", tone: "muted" });
      } else {
        result.push({ text: "└─", tone: "muted" });
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
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
    let text = heading ? heading[1]! : raw;
    text = text
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => label === url ? url : `${label} (${url})`)
      .replace(/\*\*([^*]+)\*\*/g, "\u001b[1m$1\u001b[22m")
      .replace(/__([^_]+)__/g, "\u001b[1m$1\u001b[22m")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "\u001b[3m$1\u001b[23m")
      .replace(/`([^`]+)`/g, "\u001b[36m$1\u001b[39m")
      .replace(/^(\s*)[-*+]\s+/, "$1• ")
      .replace(/^\s*>\s?/, "│ ");
    const wrapped = wrapAnsi(text || " ", columns, { hard: true, trim: false }).split("\n");
    for (const line of wrapped) result.push({ text: line, tone: heading ? "heading" : "normal", bold: Boolean(heading) });
  }
  return result;
}

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
    const list = !heading ? /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(raw) : null;
    const quote = !heading && !list ? /^\s*>\s?(.*)$/.exec(raw) : null;
    let prefix = list ? `${list[1]}${/^\d/.test(list[2]!) ? list[2] : "•"} ` : quote ? "│ " : "";
    // Leave room for at least one character in narrow terminals.
    if (prefix.length >= columns) prefix = "";
    let text = heading ? heading[1]! : list ? list[3]! : quote ? quote[1]! : raw;
    text = text
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => label === url ? url : `${label} (${url})`)
      .replace(/\*\*([^*]+)\*\*/g, "\u001b[1m$1\u001b[22m")
      .replace(/__([^_]+)__/g, "\u001b[1m$1\u001b[22m")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "\u001b[3m$1\u001b[23m")
      .replace(/`([^`]+)`/g, "\u001b[36m$1\u001b[39m");
    const wrapped = wrapAnsi(text || " ", Math.max(1, columns - prefix.length), { hard: true, trim: false }).split("\n");
    for (const [index, line] of wrapped.entries()) {
      result.push({ text: `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`, tone: heading ? "heading" : "normal", bold: Boolean(heading) });
    }
  }
  return result;
}

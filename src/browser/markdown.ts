import type { Locator } from "playwright";
import TurndownService from "turndown";
import gfmPlugin from "turndown-plugin-gfm";

// Capture the answer subtree and reconstruct Markdown locally. The original
// source is not exposed by the rendered DOM and cannot be recovered verbatim.
const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
converter.use(gfmPlugin.gfm);
converter.addRule("readableListItem", {
  filter: "li",
  replacement: (content, node) => {
    const element = node as HTMLElement;
    const parent = element.parentElement;
    const siblings = parent ? Array.from(parent.children) : [];
    const start = Number(parent?.getAttribute("start") || 1);
    const marker = parent?.tagName.toLowerCase() === "ol" ? `${start + siblings.indexOf(element)}.` : "-";
    const body = content.replace(/^\n+|\n+$/g, "");
    return `${marker} ${body.replace(/\n/g, `\n${" ".repeat(marker.length + 1)}`)}\n`;
  },
});
converter.addRule("chatgptMath", {
  filter: (node) => node.hasAttribute("data-harness-math"),
  replacement: (_content, node) => {
    const element = node as HTMLElement;
    const source = element.getAttribute("data-harness-math") ?? "";
    return element.getAttribute("data-harness-display") === "true" ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
  },
});

// The GFM plugin deliberately keeps headerless tables as raw HTML. ChatGPT
// uses those tables for rich cards, so convert both kinds to Markdown. An
// empty header is structural and is not presented as a row in the TUI.
converter.addRule("chatgptTable", {
  filter: "table",
  replacement: (_content, node) => {
    const table = node as HTMLElement;
    const tableRows = Array.from(table.querySelectorAll("tr")).filter((row) => row.closest("table") === table);
    const rows: string[][] = [];
    const remaining: number[] = [];
    for (const row of tableRows) {
      const values: string[] = [];
      const cells = Array.from(row.children).filter((cell) => /^(?:TD|TH)$/.test(cell.tagName));
      let col = 0;
      for (const cell of cells) {
        while ((remaining[col] ?? 0) > 0) { values[col] = ""; remaining[col]!--; col++; }
        const value = converter.turndown(cell.innerHTML).trim().replace(/\s*\n+\s*/g, " <br> ").replace(/(?<!\\)\|/g, "\\|");
        const colSpan = Math.min(100, Math.max(1, Number(cell.getAttribute("colspan")) || 1));
        const rowSpan = Math.min(tableRows.length, Math.max(1, Number(cell.getAttribute("rowspan")) || 1));
        for (let offset = 0; offset < colSpan; offset++) {
          values[col] = offset ? "" : value;
          remaining[col] = rowSpan - 1;
          col++;
        }
      }
      while (col < remaining.length) { if ((remaining[col] ?? 0) > 0) { values[col] = ""; remaining[col]!--; } col++; }
      if (values.length) rows.push(values);
    }
    const caption = table.querySelector("caption")?.textContent?.trim();
    if (!rows.length) return caption ? `\n\n${caption}\n\n` : "";
    const columns = Math.max(...rows.map((row) => row.length));
    const first = tableRows[0];
    const firstCells = first ? Array.from(first.children).filter((cell) => /^(?:TD|TH)$/.test(cell.tagName)) : [];
    const hasHeader = first?.parentElement?.tagName === "THEAD" || (firstCells.length > 0 && firstCells.every((cell) => cell.tagName === "TH"));
    const encode = (row: string[]) => `| ${Array.from({ length: columns }, (_, index) => row[index] ?? "").join(" | ")} |`;
    const header = hasHeader ? rows.shift()! : Array<string>(columns).fill("");
    const separator = `| ${Array<string>(columns).fill("---").join(" | ")} |`;
    return `\n\n${caption ? `${caption}\n\n` : ""}${[encode(header), separator, ...rows.map(encode)].join("\n")}\n\n`;
  },
});
// Turndown visits children before the table rule. GFM's row rule assumes
// every child is a cell and can throw on whitespace nodes in a header row.
converter.addRule("safeTableRow", { filter: "tr", replacement: (content) => content });

// Older sessions already contain the raw serialized table. Convert complete
// tables outside fenced code without changing the stored session or user text.
export function convertStoredHtmlTables(input: string): string {
  if (!/<table(?:\s|>)/i.test(input)) return input;
  const convert = (text: string): string => {
    const tags = /<\/?table(?=\s|>)(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*>/gi;
    let depth = 0, start = -1, offset = 0, output = "";
    for (const match of text.matchAll(tags)) {
      const index = match.index;
      if (match[0].startsWith("</")) {
        if (!depth) continue;
        if (--depth === 0 && start >= 0) {
          const end = index + match[0].length;
          const html = text.slice(start, end);
          let replacement = html;
          try { replacement = converter.turndown(html).trim() || html; } catch { /* Keep the original if parsing fails. */ }
          output += text.slice(offset, start) + `\n\n${replacement}\n\n`;
          offset = end;
          start = -1;
        }
      } else if (depth++ === 0) start = index;
    }
    return output + text.slice(offset);
  };
  let normal = "", result = "", fence = "", fenceLength = 0;
  for (const line of input.split(/(?<=\n)/)) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
    if (match && (!fence || (match[1]![0] === fence && match[1]!.length >= fenceLength && !match[2]!.trim()))) {
      if (!fence) { result += convert(normal); normal = ""; fence = match[1]![0]!; fenceLength = match[1]!.length; }
      else { fence = ""; fenceLength = 0; }
      result += line;
    } else if (fence) result += line;
    else normal += line;
  }
  return result + convert(normal);
}

export async function readMarkdown(locator: Locator): Promise<string> {
  const html = await locator.evaluate((root) => {
    const containerSelector = '.markdown, [data-markdown-text-style="assistant-message"], .puik-root.not-markdown > [class*="_DilResponseRoot"]';
    const parent = root.parentElement?.closest(containerSelector);
    if (parent && parent.closest('[data-message-author-role="assistant"], [data-message-author="assistant"]') === root.closest('[data-message-author-role="assistant"], [data-message-author="assistant"]')) return "";
    if (root.closest('[data-markdown-copy="exclude"]')) return "";
    // Activity summaries can be nested in an answer container; classify each
    // original DOM node, before flattening to Markdown, so commentary remains.
    const markers = Array.from(document.querySelectorAll("[data-chatgpt-agent-turn-start]"));
    const isActivitySummary = (node: Element): boolean => {
      if (node.closest("pre, code") || node.closest("[data-content-search-unit-key]")) return false;
      if (node.closest('[class~="group/activity-header"]')) return true;
      return Boolean(node.closest('[data-markdown-text-tone="tertiary"]') && markers.some((marker) => marker.parentElement?.contains(node)));
    };
    if (isActivitySummary(root)) return "";
    const clone = root.cloneNode(true) as HTMLElement;
    const statusSelector = '[data-markdown-text-tone="tertiary"], [class~="group/activity-header"]';
    const originalStatuses = root.querySelectorAll(statusSelector);
    const clonedStatuses = clone.querySelectorAll(statusSelector);
    for (let index = 0; index < originalStatuses.length; index += 1) {
      if (isActivitySummary(originalStatuses[index]!)) clonedStatuses[index]?.remove();
    }
    for (const card of clone.querySelectorAll('[data-markdown-copy="rich-block"]')) {
      const bodies = Array.from(card.querySelectorAll('[data-markdown-copy-content="true"]')).filter((body) => body.closest('[data-markdown-copy="rich-block"]') === card);
      if (bodies.length === 1) card.replaceChildren(...Array.from(bodies[0]!.childNodes));
    }
    for (const math of clone.querySelectorAll(".katex-display, .katex")) {
      if (math.closest("pre, code") || math.parentElement?.closest(".katex-display, .katex")) continue;
      const source = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (!source) continue;
      const replacement = document.createElement(math.classList.contains("katex-display") ? "div" : "span");
      replacement.setAttribute("data-harness-math", source);
      replacement.setAttribute("data-harness-display", String(math.classList.contains("katex-display")));
      replacement.textContent = source;
      math.replaceWith(replacement);
    }
    for (const block of clone.querySelectorAll('[data-markdown-copy="code-block"]')) {
      const editor = block.querySelector<HTMLElement>(".cm-content");
      const codes = block.querySelectorAll("code");
      if (!editor && (codes.length !== 1 || block.querySelector("pre"))) continue;
      const pre = document.createElement("pre");
      const code = editor ? document.createElement("code") : codes[0]!.cloneNode(true) as HTMLElement;
      if (editor) {
        const lines = Array.from(editor.querySelectorAll(".cm-line"));
        const language = editor.dataset.language;
        if (language && /^[\w+-]+$/.test(language)) code.className = `language-${language}`;
        code.textContent = lines.length ? lines.map((line) => line.textContent ?? "").join("\n") : editor.textContent;
      }
      pre.append(code);
      block.replaceWith(pre);
    }
    for (const button of clone.querySelectorAll("button")) {
      if (button.classList.contains("group/suggested-followup")) for (const sibling of Array.from(button.parentElement?.parentElement?.children ?? [])) if (sibling.matches('[aria-hidden="true"].pointer-events-none')) sibling.remove();
      if (button.matches(".behavior-btn.entity-underline") && !button.closest('[hidden], [aria-hidden="true"]')) button.replaceWith(document.createTextNode(button.textContent ?? ""));
      else button.remove();
    }
    for (const icon of clone.querySelectorAll("svg")) {
      if (icon.closest("pre, code") || icon.parentElement?.closest('[hidden], [aria-hidden="true"]')) continue;
      const name = [icon.getAttribute("aria-label"), icon.getAttribute("data-icon"), icon.getAttribute("data-testid"), icon.getAttribute("class"), icon.querySelector("title")?.textContent].filter(Boolean).join(" ");
      if (/(?:^|[\s_:-])(?:check|checkmark|tick|success|passed|complete)(?:$|[\s_:-])/i.test(name)) icon.replaceWith(document.createTextNode("✓ "));
      else if (/(?:^|[\s_:-])(?:cross|error|failed)(?:$|[\s_:-])/i.test(name)) icon.replaceWith(document.createTextNode("✗ "));
    }
    for (const hidden of clone.querySelectorAll('[hidden], [aria-hidden="true"]')) if (!hidden.closest("pre, code")) hidden.remove();
    for (const element of clone.querySelectorAll('script, style, svg, [data-markdown-copy="exclude"], .katex-mathml, .chart-widget-container, [data-code-block-preview-pane], [role="tooltip"]')) element.remove();
    return clone.innerHTML;
  }).catch(() => "");
  if (!html) return "";
  try { return converter.turndown(html).trim(); } catch { return ""; }
}

// The text fallback may include activity headers alongside the answer. Return
// their observed labels separately so only actual UI nodes can be removed.
export async function readFallbackText(locator: Locator): Promise<{ text: string; activityLabels: string[] }> {
  return locator.evaluate((root) => {
    const markers = Array.from(document.querySelectorAll("[data-chatgpt-agent-turn-start]"));
    const labels = new Set<string>();
    for (const node of root.querySelectorAll<HTMLElement>('[data-markdown-text-tone="tertiary"], [class~="group/activity-header"]')) {
      if (node.closest('pre, code, [data-content-search-unit-key]')) continue;
      const header = node.closest('[class~="group/activity-header"]');
      const activity = markers.some((marker) => marker.parentElement?.contains(node));
      if (!header && !(node.matches('[data-markdown-text-tone="tertiary"]') && activity)) continue;
      for (const line of (node.innerText || "").split("\n")) if (line.trim()) labels.add(line.trim());
    }
    return { text: (root as HTMLElement).innerText ?? "", activityLabels: [...labels] };
  }).catch(() => ({ text: "", activityLabels: [] }));
}

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

export async function readMarkdown(locator: Locator): Promise<string> {
  const html = await locator.evaluate((root) => {
    const containerSelector = '.markdown, [data-markdown-text-style="assistant-message"], .puik-root.not-markdown > [class*="_DilResponseRoot"]';
    const parent = root.parentElement?.closest(containerSelector);
    if (parent && parent.closest('[data-message-author-role="assistant"], [data-message-author="assistant"]') === root.closest('[data-message-author-role="assistant"], [data-message-author="assistant"]')) return "";
    if (root.closest('[data-markdown-copy="exclude"]')) return "";
    // Activity uses tertiary Markdown for tool summaries; real commentary and
    // final answer units can use the same renderer and must remain visible.
    const activity = Array.from(document.querySelectorAll("[data-chatgpt-agent-turn-start]"))
      .some((marker) => marker.parentElement?.contains(root));
    if (activity && root.closest('[data-markdown-text-tone="tertiary"]') && !root.closest("[data-content-search-unit-key]")) return "";
    const clone = root.cloneNode(true) as HTMLElement;
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
    for (const hidden of clone.querySelectorAll('[hidden], [aria-hidden="true"]')) if (!hidden.closest("pre, code")) hidden.remove();
    for (const element of clone.querySelectorAll('script, style, svg, [data-markdown-copy="exclude"], .katex-mathml, .chart-widget-container, [data-code-block-preview-pane], [role="tooltip"]')) element.remove();
    return clone.innerHTML;
  }).catch(() => "");
  if (!html) return "";
  try { return converter.turndown(html).trim(); } catch { return ""; }
}

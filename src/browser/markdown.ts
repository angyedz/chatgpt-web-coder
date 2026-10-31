import type { Locator } from "playwright";

export async function readMarkdown(locator: Locator): Promise<string> {
  return locator.evaluate((root) => {
    const render = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof HTMLElement)) return "";
      const tag = node.tagName.toLowerCase();
      if (tag === "button" || tag === "script" || tag === "style") return "";
      if (tag === "pre") {
        const code = node.querySelector("code");
        const language = /language-([\w+-]+)/.exec(code?.className ?? "")?.[1] ?? "";
        return `\n\n\`\`\`${language}\n${(code ?? node).textContent?.replace(/\n$/, "") ?? ""}\n\`\`\`\n\n`;
      }
      const children = Array.from(node.childNodes).map(render).join("");
      if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${children.trim()}\n\n`;
      if (tag === "br") return "\n";
      if (tag === "p") return `${children.trim()}\n\n`;
      if (tag === "li") {
        const parent = node.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(node) : 0;
        const start = Number(parent?.getAttribute("start") || 1);
        const prefix = parent?.tagName.toLowerCase() === "ol" ? `${start + index}.` : "-";
        return `${prefix} ${children.trim()}\n`;
      }
      if (tag === "ul" || tag === "ol") return `\n${children}\n`;
      if (tag === "strong" || tag === "b") return `**${children}**`;
      if (tag === "em" || tag === "i") return `*${children}*`;
      if (tag === "code") return `\`${children}\``;
      if (tag === "a") {
        const href = node.getAttribute("href");
        return href ? `[${children}](${href})` : children;
      }
      if (tag === "blockquote") return `\n${children.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      if (tag === "tr") return `${children.trim()}\n`;
      if (tag === "td" || tag === "th") return `${children.trim()}  |  `;
      return children;
    };
    return render(root).trim();
  }).catch(() => "");
}

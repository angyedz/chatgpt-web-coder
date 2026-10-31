import type { ChatMessage } from "../types.js";

// Match a whitespace-normalized prompt while returning a slice of the original
// page text, so paragraph breaks in the answer survive the fallback path.
export function extractResponse(pageText: string, submittedPrompt: string): string {
  const normalize = (value: string): { text: string; positions: number[] } => {
    let text = "";
    const positions: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]!;
      if (/\s|[\u200B-\u200D\uFEFF]/.test(char)) {
        if (!text || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += char;
      }
      positions.push(index);
    }
    if (text.endsWith(" ")) {
      text = text.slice(0, -1);
      positions.pop();
    }
    return { text, positions };
  };
  const page = normalize(pageText);
  const prompt = normalize(submittedPrompt).text;
  if (!page.text || !prompt) return "";
  const marker = prompt.slice(-Math.min(180, prompt.length));
  const index = page.text.lastIndexOf(marker);
  let end: number | undefined;
  if (index >= 0) {
    end = page.positions[index + marker.length - 1];
  } else {
    // A long prompt can be collapsed in the conversation: its tail is then
    // absent from innerText. Anchor on its visible start and the expand control
    // so the remaining prompt is never included in the assistant response.
    const head = prompt.slice(0, Math.min(120, prompt.length));
    const headIndex = page.text.lastIndexOf(head);
    const headEnd = headIndex < 0 ? undefined : page.positions[headIndex + head.length - 1];
    if (headEnd === undefined) return "";
    const collapsed = /(?:show more|показать больше|показать ещё|показать еще)/i.exec(pageText.slice(headEnd + 1));
    if (!collapsed || collapsed.index === undefined) return "";
    end = headEnd + collapsed.index + collapsed[0].length;
  }
  if (end === undefined) return "";
  let answer = pageText.slice(end + 1).trim();
  answer = answer.replace(/^(?:[…\.\s]*Show (?:more|less)\s*)+/i, "");
  const footer = /(?:ChatGPT can make mistakes|ChatGPT may make mistakes|ChatGPT может ошибаться|Latest response|Thinking effort|Последний ответ|Уровень рассуждений)/i.exec(answer);
  if (footer?.index !== undefined) answer = answer.slice(0, footer.index);
  return cleanBrowserFallback(answer.replace(/\s+(?:Copy|Good response|Bad response|Read aloud|Regenerate response)\s*$/i, ""));
}

// Only use this for page-level/innerText fallback and old saved responses.
// Those sources can include web chrome between real assistant paragraphs.
export function cleanBrowserFallback(text: string): string {
  const normalized = removeResponseStatus(text);
  const lines = normalized.split("\n");
  const label = /^\s*(?:\*\*)?ChatGPT\s+(?:said|ответил|сказал)\s*:(?:\*\*)?\s*$/i;
  const hasLabel = lines.some((line) => label.test(line));
  const progress = /^(?:Inspecting|Checking|Listing|Searching|Reading|Reviewing|Analyzing|Creating|Building|Writing|Updating|Running|Verifying|Preparing|Exploring|Investigating)\s+(?:[A-Z][\w'-]*\s*){1,9}$/;
  const activity = /^(?:Created|Verified|Inspected|Checked|Listed|Searched|Read|Reviewed|Analyzed|Built|Updated|Ran|Prepared|Explored|Investigated)\s+.{3,170}$/;
  const significant = lines.map((line) => line.trim()).filter(Boolean);
  if (significant.length && significant.every((line) => line === significant[0]) && progress.test(significant[0]!)) return "";
  const result: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inCode = !inCode; result.push(line); continue; }
    if (!inCode && label.test(line)) {
      let previous = result.length - 1;
      while (previous >= 0 && !result[previous]!.trim()) previous -= 1;
      const candidate = previous >= 0 ? result[previous]!.trim() : "";
      if (candidate && !/[.!?]$/.test(candidate) && (activity.test(candidate) || progress.test(candidate))) result.splice(previous, 1);
      continue;
    }
    if (!inCode && hasLabel && /^\s*(?:Skip|Пропустить)\s*$/i.test(line)) continue;
    result.push(line);
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Old sessions may contain a whole turn again after a tool. Compute a clean
// view without modifying the saved messages or the user's own text.
export function cleanAssistantHistory(messages: ChatMessage[]): Map<string, string> {
  const result = new Map<string, string>();
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") { parts.length = 0; continue; }
    if (message.role !== "assistant") continue;
    let text = cleanBrowserFallback(message.text);
    if (text && parts.length && parts[0]!.length >= 20 && text.startsWith(parts[0]!)) {
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const previous = parts[index]!;
        if (previous.length < 20) continue;
        const position = text.lastIndexOf(previous);
        if (position >= 0) { text = text.slice(position + previous.length).trimStart(); break; }
      }
    }
    result.set(message.id, text);
    if (text && !message.streaming) parts.push(text);
  }
  return result;
}
// ChatGPT may expose its progress label inside an assistant message before it
// renders any actual answer. Do not treat that label as model output.
export function removeResponseStatus(text: string): string {
  const status = /^(?:chatgpt\s+(?:is\s+)?(?:responding|thinking|working|generating(?:\s+(?:a\s+)?(?:response|reply))?)|chatgpt\s+(?:отвечает|думает|размышляет|печатает|генерирует ответ))(?:\s*(?:\.{1,3}|…))?$/i;
  return text.replace(/\r\n?/g, "\n").split("\n").filter((line) => {
    const plain = line.trim().replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/, "$1").trim();
    return !status.test(plain);
  }).join("\n").trim();
}


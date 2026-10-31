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
  const label = /ChatGPT\s+(?:said|ответил|сказал)\s*:/i.exec(answer);
  if (label?.index !== undefined) {
    answer = answer.slice(label.index + label[0].length);
  } else {
    answer = answer.replace(/^(?:[…\.\s]*Show (?:more|less)\s*)+/i, "");
  }
  const footer = /(?:ChatGPT can make mistakes|ChatGPT may make mistakes|ChatGPT может ошибаться|Latest response|Thinking effort|Последний ответ|Уровень рассуждений)/i.exec(answer);
  if (footer?.index !== undefined) answer = answer.slice(0, footer.index);
  return removeResponseStatus(answer.replace(/\s+(?:Copy|Good response|Bad response|Read aloud|Regenerate response)\s*$/i, ""));
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


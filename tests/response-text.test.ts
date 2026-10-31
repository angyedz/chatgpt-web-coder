import { describe, expect, it } from "vitest";
import { HarnessEvents } from "../src/events.js";
import { ResponseStream } from "../src/browser/response-stream.js";
import { extractResponse, removeResponseStatus } from "../src/browser/response-text.js";
import { markdownLines } from "../src/tui/markdown.js";
import type { HarnessEvent } from "../src/types.js";

describe("response display", () => {
  it("filters the UI progress label without stripping real answer text", () => {
    expect(removeResponseStatus("ChatGPT is responding")).toBe("");
    expect(removeResponseStatus("ChatGPT отвечает…\n\nПервый абзац.\n\nВторой абзац.")).toBe("Первый абзац.\n\nВторой абзац.");
    expect(removeResponseStatus("ChatGPT is responding to your question.")).toBe("ChatGPT is responding to your question.");
    expect(extractResponse("prompt\nChatGPT is responding\n\nHello.\nChatGPT can make mistakes.", "prompt")).toBe("Hello.");
  });
  it("preserves paragraphs when finding an answer in page text", () => {
    const prompt = "USER REQUEST\nFind information";
    const page = "USER REQUEST   Find information\nShow more\nChatGPT said:\n# Results\n\nFirst paragraph.\n\n- item one\n- item two\n\nChatGPT can make mistakes.";
    expect(extractResponse(page, prompt)).toBe("# Results\n\nFirst paragraph.\n\n- item one\n- item two");
  });

  it("finds the answer when the submitted prompt is collapsed", () => {
    const prompt = `${"Harness instructions. ".repeat(30)}USER REQUEST\nBuild a store`;
    const page = `${prompt.slice(0, 180)}\n…\nShow more\n\nI will inspect the project.\n\nChatGPT can make mistakes.`;
    expect(extractResponse(page, prompt)).toBe("I will inspect the project.");
    expect(extractResponse(`${prompt.slice(0, 180)}\nno expand control`, prompt)).toBe("");
  });

  it("renders Markdown sections, links, lists and indented code", () => {
    const lines = markdownLines("# Title\n\n- **Item** [site](https://example.com)\n\n```ts\n  const x = 1;\n```", 80);
    expect(lines.map((line) => line.text).join("\n").replace(/\u001b\[[0-9;]*m/g, "")).toContain("• Item site (https://example.com)");
    expect(lines.map((line) => line.text).join("\n")).toContain("│   const x = 1;");
    expect(lines.find((line) => line.text === "Title")?.tone).toBe("heading");
  });

  it("emits separate assistant messages around tool calls without repeating earlier text", () => {
    const events = new HarnessEvents();
    const seen: HarnessEvent[] = [];
    events.on((event) => seen.push(event));
    const stream = new ResponseStream(events, "answer");
    stream.update("I'll search first.");
    stream.toolStarted();
    expect(stream.hasCurrentSegment).toBe(false);
    stream.update("I'll search first.");
    stream.update("I'll search first.\n\nNow I'll read the page.");
    stream.toolStarted();
    stream.update("Final result.");
    stream.finish();
    const completed = seen.filter((event) => event.type === "assistant-done");
    expect(completed.map((event) => event.text)).toEqual(["I'll search first.", "Now I'll read the page.", "Final result."]);
  });
});

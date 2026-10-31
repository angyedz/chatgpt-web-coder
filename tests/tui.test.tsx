import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/tui/App.js";
import { Header } from "../src/tui/components/Header.js";
import { Transcript } from "../src/tui/components/Transcript.js";
import { ToolCard } from "../src/tui/components/ToolCard.js";
import { PlanPanel } from "../src/tui/components/PlanPanel.js";
import { ApprovalPrompt } from "../src/tui/components/ApprovalPrompt.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { defaultConfig } from "../src/config.js";
import { HarnessEvents } from "../src/events.js";
import type { Orchestrator } from "../src/agent/orchestrator.js";
import type {
  ApprovalRequest,
  ChatMessage,
  ToolCallView,
} from "../src/types.js";

afterEach(() => cleanup());

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function strip(value = ""): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function fakeOrchestrator() {
  const events = new HarnessEvents();
  const config = defaultConfig(process.cwd());
  const approve = vi.fn();
  const submit = vi.fn(async () => undefined);
  const cancel = vi.fn();
  const orchestrator = {
    events,
    config,
    mcpUrl: "http://127.0.0.1:8790/mcp",
    approve,
    submit,
    cancel,
  } as unknown as Orchestrator;
  return { orchestrator, events, config, approve, submit, cancel };
}

const userMessage: ChatMessage = {
  id: "m1",
  role: "user",
  text: "build a todo app",
  createdAt: 1,
};

const toolCall: ToolCallView = {
  id: "t1",
  name: "exec_command",
  args: { cmd: "npm test" },
  status: "ok",
  startedAt: 2,
  endedAt: 1250,
  output: "15 passed",
};

describe("TUI components", () => {
  it("renders the header with connection state and approval mode", () => {
    const { lastFrame } = render(
      <Header
        model="GPT-5.5"
        session={{ temporary: true }}
        approvalMode="ask"
        status={{
          browser: { state: "up" },
          mcp: { state: "up" },
          tunnel: { state: "error", detail: "401" },
          searxng: { state: "off" },
        }}
      />,
    );
    const frame = strip(lastFrame());
    expect(frame).toContain("chatgpt-coder");
    expect(frame).toContain("GPT-5.5");
    expect(frame).toContain("temporary chat");
    expect(frame).toContain("browser");
    expect(frame).toContain("tunnel");
    expect(frame).toContain("approval");
    expect(frame).toContain("ask");
  });

  it("renders session shortcuts when the transcript is empty", () => {
    const { lastFrame } = render(
      <Transcript messages={[]} tools={[]} height={20} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toContain("session");
    expect(frame).toContain("/help");
  });

  it("renders messages and tool cards in chronological order", async () => {
    const { lastFrame } = render(
      <Transcript messages={[userMessage]} tools={[toolCall]} height={30} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toContain("you");
    expect(frame).toContain("build a todo app");
    expect(frame).toContain("exec_command");
    expect(frame).toContain("npm test");
    expect(frame).not.toContain("15 passed");
    expect(frame).toContain("1.2s");
    expect(frame.indexOf("build a todo app")).toBeLessThan(
      frame.indexOf("exec_command"),
    );
  });

  it("clips long responses by terminal rows without painting over tools", () => {
    const longMessage: ChatMessage = {
      id: "long", role: "assistant", createdAt: 1,
      text: Array.from({ length: 30 }, (_, index) => `Response line ${index}`).join("\n"),
    };
    const { lastFrame } = render(<Transcript messages={[longMessage]} tools={[toolCall]} height={8} />);
    const frame = strip(lastFrame());
    const lines = frame.split("\n");
    expect(lines).toHaveLength(8);
    expect(frame).toContain("Response line 29");
    expect(frame).toContain("exec_command");
    expect(lines.find((line) => line.includes("exec_command"))).not.toContain("Response line");
  });

  it("allows earlier lines of a long response to be viewed", () => {
    const longMessage: ChatMessage = {
      id: "long", role: "assistant", createdAt: 1,
      text: Array.from({ length: 30 }, (_, index) => `Response line ${index}`).join("\n"),
    };
    const { lastFrame } = render(<Transcript messages={[longMessage]} tools={[toolCall]} height={8} scrollOffset={100} />);
    const frame = strip(lastFrame());
    expect(frame).toContain("history");
    expect(frame).toContain("Response line 0");
    expect(frame).not.toContain("Response line 29");
  });

  it("shows a spinner for running tools and a cross for failures", () => {
    const running = render(
      <ToolCard
        call={{ ...toolCall, status: "running", endedAt: undefined, output: undefined }}
      />,
    );
    expect(strip(running.lastFrame())).toContain("exec_command");
    running.unmount();

    const failed = render(
      <ToolCard
        call={{ ...toolCall, status: "error", output: undefined, error: "boom" }}
      />,
    );
    const frame = strip(failed.lastFrame());
    expect(frame).toContain("✗");
    expect(frame).toContain("boom");
  });

  it("renders plan steps with their status glyphs", () => {
    const { lastFrame } = render(
      <PlanPanel
        steps={[
          { step: "inspect repo", status: "completed" },
          { step: "write code", status: "in_progress" },
          { step: "run tests", status: "pending" },
        ]}
      />,
    );
    const frame = strip(lastFrame());
    expect(frame).toContain("PLAN");
    expect(frame).toContain("inspect repo");
    expect(frame).toContain("write code");
    expect(frame).toContain("run tests");
    expect(frame).toContain("◉");
  });

  it("renders an approval request with its arguments", () => {
    const request: ApprovalRequest = {
      id: "a1",
      tool: "exec_command",
      summary: "Run in .:\nnpm test",
      args: { cmd: "npm test" },
      createdAt: 1,
    };
    const { lastFrame } = render(<ApprovalPrompt request={request} />);
    const frame = strip(lastFrame());
    expect(frame).toContain("exec_command");
    expect(frame).toContain("npm test");
    expect(frame).toContain("y allow");
    expect(frame).toContain("n deny");
  });

  it("renders the status bar", () => {
    const { lastFrame } = render(
      <StatusBar
        phase="tool"
        workspace="C:\\work\\demo"
        mcpUrl="http://127.0.0.1:8790/mcp"
        tunnelDetail="up"
        approvalMode="never"
      />,
    );
    const frame = strip(lastFrame());
    expect(frame).toContain("local tool running");
    expect(frame).toContain("demo");
  });
});

describe("App", () => {
  it("scrolls the transcript with Page Up and Page Down", async () => {
    const { orchestrator, events } = fakeOrchestrator();
    const { stdin, lastFrame } = render(<App orchestrator={orchestrator} />);
    events.emit({ type: "assistant-done", id: "long", text: Array.from({ length: 60 }, (_, index) => `Line ${index}`).join("\n") });
    await tick();
    expect(strip(lastFrame())).toContain("Line 59");
    stdin.write("\u001b[5~");
    await tick();
    expect(strip(lastFrame())).toContain("history");
    expect(strip(lastFrame())).not.toContain("Line 59");
    stdin.write("\u001b[6~");
    await tick();
    expect(strip(lastFrame())).toContain("Line 59");
  });

  it("renders chrome and streams orchestrator events into the transcript", async () => {
    const { orchestrator, events } = fakeOrchestrator();
    const { lastFrame } = render(<App orchestrator={orchestrator} />);

    expect(strip(lastFrame())).toContain("/help");
    expect(strip(lastFrame())).toContain("● mcp");

    events.emit({ type: "session", session: { temporary: true, model: "GPT-5.5" } });
    events.emit({ type: "status", key: "mcp", state: "up" });
    events.emit({ type: "status", key: "tunnel", state: "up", detail: "connected" });
    events.emit({ type: "user-message", id: "u1", text: "list the files" });
    events.emit({ type: "phase", phase: "thinking" });
    events.emit({ type: "assistant-start", id: "a1" });
    events.emit({ type: "assistant-delta", id: "a1", text: "Listing" });
    events.emit({ type: "assistant-delta", id: "a1", text: "Listing files…" });
    events.emit({ type: "assistant-done", id: "a1", text: "Listing files…" });
    events.emit({
      type: "tool-start",
      call: { ...toolCall, status: "running", endedAt: undefined, output: undefined },
    });
    events.emit({ type: "tool-end", call: toolCall });
    events.emit({
      type: "plan",
      steps: [{ step: "list files", status: "completed" }],
    });
    events.emit({ type: "notice", level: "info", text: "MCP ready" });
    await tick();

    const frame = strip(lastFrame());
    expect(frame).toContain("list the files");
    expect(frame).toContain("Listing files");
    expect(frame).toContain("exec_command");
    expect(frame).not.toContain("15 passed");
    expect(frame).toContain("list files");
    expect(frame).toContain("MCP ready");
    expect(frame).toContain("ChatGPT is thinking");
  });

  it("shows approval prompts and forwards y/n answers", async () => {
    const { orchestrator, events, approve } = fakeOrchestrator();
    const { lastFrame, stdin } = render(<App orchestrator={orchestrator} />);

    events.emit({
      type: "approval",
      request: {
        id: "ap1",
        tool: "write_file",
        summary: "write src/index.ts",
        args: { path: "src/index.ts" },
        createdAt: 1,
      },
    });
    await tick();

    expect(strip(lastFrame())).toContain("write src/index.ts");

    stdin.write("y");
    await tick();
    expect(approve).toHaveBeenCalledWith("ap1", true);
    expect(strip(lastFrame())).not.toContain("write src/index.ts");
  });

  it("queues simultaneous approvals from foreground and background work", async () => {
    const { orchestrator, events, approve } = fakeOrchestrator();
    const { stdin, lastFrame } = render(<App orchestrator={orchestrator} />);
    events.emit({ type: "approval", request: { id: "one", tool: "write_file", summary: "first approval", args: {}, createdAt: 1 } });
    events.emit({ type: "approval", request: { id: "two", tool: "exec_command", summary: "second approval", args: {}, createdAt: 2 } });
    await tick();
    expect(strip(lastFrame())).toContain("first approval");
    stdin.write("y");
    await tick();
    expect(approve).toHaveBeenCalledWith("one", true);
    expect(strip(lastFrame())).toContain("second approval");
    stdin.write("n");
    await tick();
    expect(approve).toHaveBeenCalledWith("two", false);
  });

  it("submits typed input and clears the input bar", async () => {
    const { orchestrator, submit } = fakeOrchestrator();
    const { lastFrame, stdin } = render(<App orchestrator={orchestrator} />);

    stdin.write("make a plan");
    await tick();
    stdin.write("\r");
    await tick();

    expect(submit).toHaveBeenCalledWith("make a plan");
    expect(strip(lastFrame())).not.toContain("make a plan");
  });

  it("navigates previous messages and restores the draft without retaining commands", async () => {
    const { orchestrator, submit } = fakeOrchestrator();
    const { lastFrame, stdin } = render(<App orchestrator={orchestrator} />);
    const send = async (text: string) => {
      stdin.write(text);
      await tick();
      stdin.write("\r");
      await tick();
    };
    await send("first message");
    await send("second message");
    await send("/help");
    stdin.write("draft");
    await tick();
    stdin.write("\u001b[A");
    await tick();
    expect(strip(lastFrame())).toContain("second message");
    stdin.write("\u001b[A");
    await tick();
    expect(strip(lastFrame())).toContain("first message");
    stdin.write("\u001b[B");
    await tick();
    expect(strip(lastFrame())).toContain("second message");
    stdin.write("\u001b[B");
    await tick();
    expect(strip(lastFrame())).toContain("draft");
    stdin.write("\u001b[A");
    await tick();
    stdin.write(" edited");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submit).toHaveBeenLastCalledWith("second message edited");
  });

  it("cancels the running turn on escape", async () => {
    const { orchestrator, events, cancel } = fakeOrchestrator();
    const { stdin } = render(<App orchestrator={orchestrator} />);

    events.emit({ type: "turn-start", turnId: "turn1" });
    await tick();
    stdin.write("\u001B");
    await tick();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("shows stopping and ignores further escape presses while cancelling", async () => {
    const { orchestrator, events, cancel } = fakeOrchestrator();
    const { stdin, lastFrame } = render(<App orchestrator={orchestrator} />);
    events.emit({ type: "turn-start", turnId: "turn1" });
    events.emit({ type: "phase", phase: "cancelling" });
    await tick();
    stdin.write("\u001B");
    await tick();
    expect(cancel).not.toHaveBeenCalled();
    expect(strip(lastFrame())).toContain("Stopping");
  });
});

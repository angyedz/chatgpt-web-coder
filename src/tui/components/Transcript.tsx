import React, { useEffect, useLayoutEffect, useState } from "react";
import { Box, Text, useWindowSize } from "ink";
import type { ChatMessage, ToolCallView } from "../../types.js";
import { cleanAssistantHistory } from "../../browser/response-text.js";
import { markdownLines } from "../markdown.js";
import { terminalText } from "../terminal-text.js";
import { glyphs, theme } from "../theme.js";
import { toolDisplayLines } from "./ToolCard.js";

type Entry =
  | { kind: "message"; time: number; order?: number; message: ChatMessage }
  | { kind: "tool"; time: number; order?: number; call: ToolCallView };

interface TranscriptProps {
  messages: ChatMessage[];
  tools: ToolCallView[];
  height: number;
  systemView?: boolean;
  scrollOffset?: number;
  onScrollLimit?: (limit: number) => void;
}

interface Row {
  key: string;
  text: string;
  color?: string;
  bold?: boolean;
  rail?: string;
  railColor?: string;
}

export function Transcript({ messages, tools, height, systemView = false, scrollOffset = 0, onScrollLimit }: TranscriptProps) {
  const { columns = 80 } = useWindowSize();
  const [frame, setFrame] = useState(0);
  const running = tools.some((call) => call.status === "running");
  const reducedMotion = process.env.CHATGPT_CODER_REDUCED_MOTION === "1" || process.env.CI === "true";
  useEffect(() => {
    if (!running || reducedMotion) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 140);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [running, reducedMotion]);
  // Limit prose width on wide terminals and reserve space for the message rail.
  const width = Math.max(1, Math.min(96, columns - 7));
  const entries: Entry[] = [
    ...messages.map((message) => ({ kind: "message" as const, time: message.createdAt, order: message.order, message })),
    ...tools.map((call) => ({ kind: "tool" as const, time: call.startedAt, order: call.order, call })),
  ];
  // Older saved sessions can contain entries without sequence numbers. Never
  // compare a sequence number to a timestamp: choose one scale for the list.
  const hasCompleteOrder = entries.every((entry) => Number.isFinite(entry.order));
  entries.sort((a, b) => hasCompleteOrder ? a.order! - b.order! : a.time - b.time);

  const rows: Row[] = [];
  const cleaned = cleanAssistantHistory(entries.flatMap((entry) => entry.kind === "message" ? [entry.message] : []));
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.kind === "tool") {
      if (entryIndex > 0 && entries[entryIndex - 1]?.kind !== "tool") {
        rows.push({ key: `${entry.call.id}:space`, text: " " });
      }
      if (entryIndex === 0 || entries[entryIndex - 1]?.kind !== "tool") {
        rows.push({ key: `${entry.call.id}:group`, text: "TOOL ACTIVITY", rail: "  ┄  ", railColor: theme.border, color: theme.dim, bold: true });
      }
      toolDisplayLines(entry.call, width, reducedMotion ? 0 : frame).forEach((line, index) => {
        rows.push({ key: `${entry.call.id}:${index}`, text: line.text, rail: "  │  ", railColor: theme.border, color: line.color });
      });
      continue;
    }
    const message = entry.message;
    const isUser = message.role === "user";
    const displayText = message.role === "assistant" ? cleaned.get(message.id) ?? "" : message.text;
    if (message.role === "assistant" && !displayText && !message.streaming) continue;
    if (entryIndex > 0) rows.push({ key: `${message.id}:space`, text: " " });
    const systemTitle = message.role === "system" ? /^([^\n]{1,72})\n\s*\n/.exec(displayText) : null;
    const title = systemTitle ? terminalText(systemTitle[1]!).trim() : "";
    const label = isUser ? "you" : message.role === "assistant" ? "chatgpt" : title ? `system  ·  ${title}` : "system";
    const color = isUser ? theme.user : message.role === "assistant" ? theme.accent : theme.dim;
    const state = message.streaming ? `  ${glyphs.cursor}` : message.interrupted ? "  ·  interrupted" : "";
    rows.push({ key: `${message.id}:label`, text: `${label}${state}`, rail: "  ╭─ ", railColor: color, color, bold: true });
    const body = systemTitle ? displayText.slice(systemTitle[0].length) : displayText;
    const lines = markdownLines(body || (message.streaming ? "…" : ""), width);
    lines.forEach((line, index) => {
      rows.push({
        key: `${message.id}:${index}`,
        text: line.text,
        rail: "  │  ",
        railColor: color,
        color: line.tone === "heading" ? theme.accent : line.tone === "code" ? theme.accentAlt : line.tone === "muted" ? theme.dim : isUser ? theme.user : theme.assistant,
        bold: line.bold,
      });
    });
    rows.push({ key: `${message.id}:end`, text: "", rail: "  ╰─", railColor: color });
  }

  // Lay out and clip by actual terminal rows, not by message count. Ink/Yoga
  // otherwise shrinks long messages and paints them over the following tools.
  const showSection = height >= 4;
  const contentHeight = Math.max(1, height - (showSection ? 1 : 0));
  const hasHistory = rows.length > contentHeight && contentHeight > 1;
  const visibleHeight = Math.max(1, contentHeight - (hasHistory ? 1 : 0));
  const limit = Math.max(0, rows.length - visibleHeight);
  useLayoutEffect(() => { onScrollLimit?.(limit); }, [limit, onScrollLimit]);
  const offset = Math.min(scrollOffset, limit);
  const end = Math.max(0, rows.length - offset);
  const visible = rows.slice(Math.max(0, end - visibleHeight), end);
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={0} height={height} overflow="hidden" paddingX={1}>
      {showSection ? <Text color={theme.border} wrap="truncate-end">  ── <Text bold color={theme.dim}>{systemView ? "SYSTEM LOG" : "CONVERSATION"}</Text> {"─".repeat(Math.max(0, Math.min(24, columns - 22)))} <Text color={theme.dim}>Ctrl+O {systemView ? "chat" : "system log"}</Text></Text> : null}
      {hasHistory ? <Text color={theme.dim}>{offset > 0 ? "↑ history · PgUp / PgDn to scroll" : "↑ earlier messages · PgUp to scroll"}</Text> : null}
      {entries.length === 0 ? systemView ? <Text color={theme.dim}>  No system messages.</Text> : <Welcome height={height} /> : visible.map((row) => (
        <Text key={row.key} wrap="truncate-end"><Text color={row.railColor}>{row.rail ?? ""}</Text><Text color={row.color} bold={row.bold}>{row.text || (row.rail ? "" : " ")}</Text></Text>
      ))}
    </Box>
  );
}

function Welcome({ height }: { height: number }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={theme.border}>  ── session ──────────────────</Text>
      {height >= 2 ? <Text color={theme.dim}>  <Text color={theme.accent}>/connect</Text>  connections    <Text color={theme.accent}>/model</Text>  model &amp; effort</Text> : null}
      {height >= 3 ? <Text color={theme.dim}>  <Text color={theme.accent}>/help</Text>     commands       <Text color={theme.accent}>/sessions</Text>  history</Text> : null}
    </Box>
  );
}

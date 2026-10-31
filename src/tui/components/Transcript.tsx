import React, { useEffect } from "react";
import { Box, Text, useWindowSize } from "ink";
import type { ChatMessage, ToolCallView } from "../../types.js";
import { markdownLines } from "../markdown.js";
import { glyphs, theme } from "../theme.js";
import { toolDisplayLines } from "./ToolCard.js";

type Entry =
  | { kind: "message"; time: number; message: ChatMessage }
  | { kind: "tool"; time: number; call: ToolCallView };

interface TranscriptProps {
  messages: ChatMessage[];
  tools: ToolCallView[];
  height: number;
  scrollOffset?: number;
  onScrollLimit?: (limit: number) => void;
}

interface Row {
  key: string;
  text: string;
  color?: string;
  bold?: boolean;
}

export function Transcript({ messages, tools, height, scrollOffset = 0, onScrollLimit }: TranscriptProps) {
  const { columns = 80 } = useWindowSize();
  const width = Math.max(1, columns - 4);
  const entries: Entry[] = [
    ...messages.map((message) => ({ kind: "message" as const, time: message.order ?? message.createdAt, message })),
    ...tools.map((call) => ({ kind: "tool" as const, time: call.order ?? call.startedAt, call })),
  ].sort((a, b) => a.time - b.time);

  const rows: Row[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool") {
      toolDisplayLines(entry.call, width).forEach((line, index) => {
        rows.push({ key: `${entry.call.id}:${index}`, text: `  ${line.text}`, color: line.color });
      });
      continue;
    }
    const message = entry.message;
    const isUser = message.role === "user";
    const label = isUser ? "› you" : message.role === "assistant" ? "◆ chatgpt" : "◆ system";
    const color = isUser ? theme.user : message.role === "assistant" ? theme.accentAlt : theme.dim;
    rows.push({ key: `${message.id}:label`, text: `${label}${message.streaming ? ` ${glyphs.cursor}` : message.interrupted ? " · interrupted" : ""}`, color, bold: true });
    markdownLines(message.text || (message.streaming ? "…" : ""), width).forEach((line, index) => {
      rows.push({
        key: `${message.id}:${index}`,
        text: `  ${line.text}`,
        color: line.tone === "heading" ? theme.accent : line.tone === "code" ? theme.accentAlt : line.tone === "muted" ? theme.dim : undefined,
        bold: line.bold,
      });
    });
    rows.push({ key: `${message.id}:space`, text: " " });
  }

  // Lay out and clip by actual terminal rows, not by message count. Ink/Yoga
  // otherwise shrinks long messages and paints them over the following tools.
  const limit = Math.max(0, rows.length - Math.max(1, height - 1));
  useEffect(() => { onScrollLimit?.(limit); }, [limit, onScrollLimit]);
  const offset = Math.min(scrollOffset, limit);
  const visibleHeight = Math.max(1, height - (offset > 0 ? 1 : 0));
  const end = Math.max(0, rows.length - offset);
  const visible = rows.slice(Math.max(0, end - visibleHeight), end);
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={0} height={height} overflow="hidden" justifyContent="flex-end" paddingX={1}>
      {offset > 0 ? <Text color={theme.dim}>↑ history · PgUp / PgDn to scroll</Text> : null}
      {entries.length === 0 ? <Welcome /> : visible.map((row) => (
        <Text key={row.key} color={row.color} bold={row.bold} wrap="truncate-end">{row.text || " "}</Text>
      ))}
    </Box>
  );
}

function Welcome() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={2} paddingY={1} marginBottom={1}>
      <Text bold color={theme.accent}>Ready when you are.</Text>
      <Text>Describe a task and let ChatGPT work in your workspace.</Text>
      <Box marginTop={1} gap={2}>
        <Text color={theme.accent}>/connect</Text>
        <Text color={theme.accent}>/doctor</Text>
        <Text color={theme.accent}>/help</Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text dimColor>Enter send</Text>
        <Text dimColor>Esc cancel</Text>
        <Text dimColor>Ctrl+C quit</Text>
      </Box>
    </Box>
  );
}

import React, { useEffect, useState } from "react";
import { Box, Text, useWindowSize } from "ink";
import type { ChatMessage, ToolCallView } from "../../types.js";
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
  historicalSystemIds?: ReadonlySet<string>;
  showSystemDetails?: boolean;
  scrollOffset?: number;
  onScrollLimit?: (limit: number) => void;
}

interface Row {
  key: string;
  text: string;
  color?: string;
  bold?: boolean;
}

export function Transcript({ messages, tools, height, historicalSystemIds, showSystemDetails = false, scrollOffset = 0, onScrollLimit }: TranscriptProps) {
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
  const width = Math.max(1, columns - 4);
  const entries: Entry[] = [
    ...messages.map((message) => ({ kind: "message" as const, time: message.createdAt, order: message.order, message })),
    ...tools.map((call) => ({ kind: "tool" as const, time: call.startedAt, order: call.order, call })),
  ];
  // Older saved sessions can contain entries without sequence numbers. Never
  // compare a sequence number to a timestamp: choose one scale for the list.
  const hasCompleteOrder = entries.every((entry) => Number.isFinite(entry.order));
  entries.sort((a, b) => hasCompleteOrder ? a.order! - b.order! : a.time - b.time);

  const rows: Row[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.kind === "tool") {
      if (entryIndex > 0 && entries[entryIndex - 1]?.kind !== "tool") {
        rows.push({ key: `${entry.call.id}:space`, text: " " });
      }
      toolDisplayLines(entry.call, width, reducedMotion ? 0 : frame).forEach((line, index) => {
        rows.push({ key: `${entry.call.id}:${index}`, text: `  ${line.text}`, color: line.color });
      });
      continue;
    }
    const message = entry.message;
    const isUser = message.role === "user";
    if (entryIndex > 0) rows.push({ key: `${message.id}:space`, text: " " });
    const systemTitle = message.role === "system" ? /^([^\n]{1,72})\n\s*\n/.exec(message.text) : null;
    const title = systemTitle ? terminalText(systemTitle[1]!).trim() : "";
    const label = isUser ? "› you" : message.role === "assistant" ? "✳ chatgpt" : title ? `· system  /  ${title}` : "· system";
    const color = isUser ? theme.user : message.role === "assistant" ? theme.accent : theme.dim;
    rows.push({ key: `${message.id}:label`, text: `${label}${message.streaming ? ` ${glyphs.cursor}` : message.interrupted ? " · interrupted" : ""}`, color, bold: true });
    const body = systemTitle ? message.text.slice(systemTitle[0].length) : message.text;
    const lines = markdownLines(body || (message.streaming ? "…" : ""), width);
    const collapsed = message.role === "system" && historicalSystemIds?.has(message.id) && !showSystemDetails && lines.length > 5;
    const visibleLines = collapsed ? lines.slice(0, 2) : lines;
    visibleLines.forEach((line, index) => {
      rows.push({
        key: `${message.id}:${index}`,
        text: `  ${line.text}`,
        color: line.tone === "heading" ? theme.accent : line.tone === "code" ? theme.accentAlt : line.tone === "muted" ? theme.dim : isUser ? theme.user : theme.assistant,
        bold: line.bold,
      });
    });
    if (collapsed) rows.push({ key: `${message.id}:collapsed`, text: `  ↳ ${lines.length - visibleLines.length} more lines · Ctrl+O to expand`, color: theme.dim });
    else if (message.role === "system" && historicalSystemIds?.has(message.id) && showSystemDetails && lines.length > 5) {
      rows.push({ key: `${message.id}:expanded`, text: "  ↳ Ctrl+O to collapse", color: theme.dim });
    }
  }

  // Lay out and clip by actual terminal rows, not by message count. Ink/Yoga
  // otherwise shrinks long messages and paints them over the following tools.
  const hasHistory = rows.length > height && height > 1;
  const visibleHeight = Math.max(1, height - (hasHistory ? 1 : 0));
  const limit = Math.max(0, rows.length - visibleHeight);
  useEffect(() => { onScrollLimit?.(limit); }, [limit, onScrollLimit]);
  const offset = Math.min(scrollOffset, limit);
  const end = Math.max(0, rows.length - offset);
  const visible = rows.slice(Math.max(0, end - visibleHeight), end);
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={0} height={height} overflow="hidden" justifyContent="flex-end" paddingX={1}>
      {hasHistory ? <Text color={theme.dim}>{offset > 0 ? "↑ history · PgUp / PgDn to scroll" : "↑ earlier messages · PgUp to scroll"}</Text> : null}
      {entries.length === 0 ? <Welcome height={height} /> : visible.map((row) => (
        <Text key={row.key} color={row.color} bold={row.bold} wrap="truncate-end">{row.text || " "}</Text>
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

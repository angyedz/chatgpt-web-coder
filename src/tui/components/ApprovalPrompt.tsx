import React from "react";
import { Box, Text, useWindowSize } from "ink";
import wrapAnsi from "wrap-ansi";
import type { ApprovalRequest } from "../../types.js";
import { theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";

function previewLines(request: ApprovalRequest, columns: number, rows: number): string[] {
  const summary = terminalText(request.summary);
  const hidden = summary !== request.summary.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const wrapped = wrapAnsi(summary, Math.max(1, columns - 8), { hard: true, trim: false }).split("\n");
  if (hidden) wrapped.push("[terminal controls hidden]");
  const limit = rows < 20 ? 2 : 5;
  if (wrapped.length > limit) return [...wrapped.slice(0, Math.max(0, limit - 1)), "… preview truncated"];
  return wrapped.length ? wrapped : [" "];
}

export function approvalHeight(request: ApprovalRequest, columns: number, rows: number): number {
  return 4 + previewLines(request, columns, rows).length;
}

export function ApprovalPrompt({ request }: { request: ApprovalRequest }) {
  const { columns = 100, rows = 24 } = useWindowSize();
  const lines = previewLines(request, columns, rows);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1} marginX={1} flexShrink={0}>
      <Text wrap="truncate-end"><Text bold color={theme.warn}>◇ approval required</Text><Text color={theme.dim}>  /  </Text><Text bold>{terminalText(request.tool)}</Text></Text>
      {lines.map((line, index) => <Text key={index} color={theme.assistant} wrap="truncate-end">{line || " "}</Text>)}
      <Text wrap="truncate-end"><Text color={theme.ok}>y allow</Text><Text color={theme.dim}>  ·  </Text><Text color={theme.error}>n deny</Text><Text color={theme.dim}>  ·  Esc denies</Text></Text>
    </Box>
  );
}

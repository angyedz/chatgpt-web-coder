import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { TurnPhase } from "../../types.js";
import { theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";

interface StatusBarProps {
  phase: TurnPhase;
  workspace: string;
  mcpUrl?: string;
  tunnelDetail?: string;
  approvalMode: "ask" | "never";
  showPhase?: boolean;
}

export const phaseLabel: Record<TurnPhase, string> = {
  idle: "ready",
  sending: "sending prompt",
  uploading: "uploading attachments",
  thinking: "ChatGPT is thinking",
  responding: "ChatGPT is responding",
  tool: "local tool running",
  "waiting-approval": "waiting for approval",
  updating: "updating application",
  "downloading-update": "downloading update",
  cancelling: "stopping",
  "waiting-login": "waiting for ChatGPT login",
  error: "error",
};

export function StatusBar({ phase, workspace, approvalMode, showPhase = true }: StatusBarProps) {
  const { columns = 100 } = useWindowSize();
  const safe = terminalText(workspace);
  const available = Math.max(10, columns - (columns >= 85 ? 43 : 18));
  const short = safe.length > available ? `…${safe.slice(-(available - 1))}` : safe;
  const color = phase === "error" ? theme.error : phase === "cancelling" || phase === "waiting-approval" ? theme.warn : theme.ok;
  return (
    <Box paddingX={1} justifyContent="space-between" gap={1} flexShrink={0}>
      <Text color={theme.dim} wrap="truncate-end">{showPhase ? <><Text color={color}>{phase === "idle" ? "●" : "◌"}</Text> {phaseLabel[phase]} <Text color={theme.border}>│</Text> </> : <Text color={theme.border}>⌁ </Text>}{short}</Text>
      {columns >= 85 ? <Text color={theme.dim} wrap="truncate-end">{approvalMode === "never" ? "approval off" : "approval ask"}  ·  /help  ·  ↑ history</Text> : null}
    </Box>
  );
}

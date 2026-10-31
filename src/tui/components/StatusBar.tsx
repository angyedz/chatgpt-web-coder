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
}

const phaseLabel: Record<TurnPhase, string> = {
  idle: "ready",
  sending: "sending prompt",
  thinking: "ChatGPT is thinking",
  responding: "ChatGPT is responding",
  tool: "local tool running",
  "waiting-approval": "waiting for approval",
  updating: "updating application",
  cancelling: "stopping",
  "waiting-login": "waiting for ChatGPT login",
  error: "error",
};

export function StatusBar({
  phase,
  workspace,
  mcpUrl,
  tunnelDetail,
  approvalMode,
}: StatusBarProps) {
  const { columns: width = 100 } = useWindowSize();
  const maxWorkspace = Math.max(10, width - (width >= 100 ? 68 : 34));
  const safeWorkspace = terminalText(workspace);
  const shortWorkspace = safeWorkspace.length > maxWorkspace
    ? `…${safeWorkspace.slice(-(maxWorkspace - 1))}`
    : safeWorkspace;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Box gap={2}>
          <Text color={phase === "error" ? theme.error : phase === "cancelling" ? theme.warn : theme.accent}>
            {phase === "idle" ? "●" : "◌"} {phaseLabel[phase]}
          </Text>
          <Text dimColor>{shortWorkspace}</Text>
        </Box>
        {width >= 100 ? <Box gap={2}>
          {mcpUrl ? <Text dimColor>mcp :{new URL(mcpUrl).port}</Text> : null}
          {tunnelDetail ? <Text dimColor>tunnel {terminalText(tunnelDetail)}</Text> : null}
          <Text dimColor>approval {approvalMode}</Text>
        </Box> : null}
      </Box>
    </Box>
  );
}

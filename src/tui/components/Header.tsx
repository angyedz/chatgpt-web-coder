import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { ConnectionState, SessionInfo, SubagentSnapshot } from "../../types.js";
import { APP_VERSION } from "../../runtime/version.js";
import { theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";

interface HeaderProps {
  model?: string;
  session?: SessionInfo;
  approvalMode: "ask" | "never";
  contextUsage?: { used: number; limit: number };
  status: Record<string, { state: ConnectionState; detail?: string }>;
  localSessionId?: string;
  agents?: SubagentSnapshot[];
}

function Service({ label, state }: { label: string; state: ConnectionState }) {
  const color = state === "up" ? theme.ok : state === "starting" ? theme.warn : state === "error" ? theme.error : theme.dim;
  const mark = state === "up" ? "●" : state === "starting" ? "◌" : state === "error" ? "×" : "○";
  return <Text color={color}>{mark} <Text color={theme.dim}>{label}</Text></Text>;
}

export function Header({ model, session, approvalMode, status, localSessionId, agents = [], contextUsage = { used: 0, limit: 200_000 } }: HeaderProps) {
  const { columns = 100 } = useWindowSize();
  const ratio = Math.max(0, Math.min(1, contextUsage.used / Math.max(1, contextUsage.limit)));
  const filled = Math.round(ratio * 8);
  const meter = "━".repeat(filled) + "─".repeat(8 - filled);
  const modelLabel = terminalText(model || "auto model");
  const activeAgents = agents.filter((agent) => ["preparing", "running"].includes(agent.status)).length;
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1} flexShrink={0}>
      <Box justifyContent="space-between" gap={1}>
        <Text wrap="truncate-end"><Text bold color={theme.accent}>◈</Text><Text bold color={theme.assistant}> chatgpt-coder</Text><Text color={theme.dim}>  {APP_VERSION}{columns >= 90 && localSessionId ? `  ·  ${terminalText(localSessionId.slice(0, 8))}` : ""}</Text></Text>
        {columns >= 64 ? <Text color={theme.dim} wrap="truncate-end">{agents.length && columns >= 112 ? `◈ ${activeAgents}/${agents.length} workers  ·  ` : ""}{modelLabel}{session?.effort ? `  /  ${terminalText(session.effort)}` : ""}{columns >= 80 ? `  ·  ${session?.temporary === false ? "saved chat" : "temporary chat"}` : ""}</Text> : null}
      </Box>
      <Box justifyContent="space-between" gap={1}>
        <Box gap={1} flexShrink={1}>
          <Service label="browser" state={status.browser?.state ?? "off"} />
          <Service label="mcp" state={status.mcp?.state ?? "off"} />
          {columns >= 60 ? <Service label="tunnel" state={status.tunnel?.state ?? "off"} /> : null}
          {columns >= 95 ? <Service label="search" state={status.searxng?.state ?? "off"} /> : null}
          {columns >= 112 ? <Service label="telegram" state={status.telegram?.state ?? "off"} /> : null}
          {columns >= 80 ? <Text color={theme.dim}>approval <Text color={approvalMode === "never" ? theme.warn : theme.accent}>{approvalMode}</Text></Text> : null}
        </Box>
        {columns >= 80 ? <Text color={theme.dim}>context <Text color={ratio >= 0.8 ? theme.warn : theme.accent}>{meter}</Text> {Math.round(ratio * 100)}%</Text> : null}
      </Box>
    </Box>
  );
}

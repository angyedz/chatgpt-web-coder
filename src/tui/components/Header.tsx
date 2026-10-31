import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { ConnectionState, SessionInfo } from "../../types.js";
import { glyphs, theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";

interface HeaderProps {
  model?: string;
  session?: SessionInfo;
  approvalMode: "ask" | "never";
  contextUsage?: { used: number; limit: number };
  status: Record<string, { state: ConnectionState; detail?: string }>;
  localSessionId?: string;
}

function Service({ label, state }: { label: string; state: ConnectionState }) {
  const color = state === "up" ? theme.ok : state === "starting" ? theme.warn : state === "error" ? theme.error : theme.dim;
  const mark = state === "up" ? glyphs.dot : state === "error" ? glyphs.cross : glyphs.dotEmpty;
  return <Text><Text color={color}>{mark}</Text> {label}</Text>;
}

export function Header({ model, session, approvalMode, status, localSessionId, contextUsage = { used: 0, limit: 200_000 } }: HeaderProps) {
  const { columns = 100 } = useWindowSize();
  const ratio = Math.min(1, contextUsage.used / Math.max(1, contextUsage.limit));
  const meterColor = ratio >= 0.8 ? theme.warn : theme.accent;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} justifyContent="space-between">
        <Text><Text bold color={theme.accent}>◆ chatgpt-coder</Text>{columns >= 65 ? <Text dimColor>  /  your coding workspace</Text> : null}{columns >= 110 && localSessionId ? <Text dimColor>  ·  {terminalText(localSessionId.slice(0, 8))}</Text> : null}</Text>
        {columns >= 80 ? <Text dimColor>{terminalText(model || "auto model")}  ·  {session?.temporary === false ? "saved chat" : "temporary chat"}</Text> : null}
      </Box>
      <Box paddingX={2} gap={2}>
        <Service label="browser" state={status.browser?.state ?? "off"} />
        <Service label="mcp" state={status.mcp?.state ?? "off"} />
        {columns >= 65 ? <Service label="tunnel" state={status.tunnel?.state ?? "off"} /> : null}
        {columns >= 105 ? <Service label="search" state={status.searxng?.state ?? "off"} /> : null}
        {columns >= 80 ? <Text dimColor>approval <Text color={approvalMode === "never" ? theme.warn : theme.accent}>{approvalMode}</Text></Text> : null}
        {columns >= 100 ? <><Box flexGrow={1} /><Box><Text color={meterColor}>context {Math.round(ratio * 100)}%</Text><Text dimColor>  {Math.round(contextUsage.used / 1000)}k / {Math.round(contextUsage.limit / 1000)}k</Text></Box></> : null}
      </Box>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";
import type { SubagentSnapshot } from "../../types.js";
import { theme } from "../theme.js";

export function agentColor(status: SubagentSnapshot["status"]): string {
  switch (status) {
    case "done": return theme.ok;
    case "failed": return theme.error;
    case "stopped": return theme.warn;
    case "running": return theme.accent;
    default: return theme.dim;
  }
}

export function agentSymbol(status: SubagentSnapshot["status"]): string {
  switch (status) {
    case "done": return "✓";
    case "failed": return "×";
    case "stopped": return "–";
    case "running": return "●";
    default: return "○";
  }
}

export function SubagentStrip({ agents, columns }: { agents: SubagentSnapshot[]; columns: number }) {
  const active = agents.filter((agent) => ["preparing", "running"].includes(agent.status)).length;
  const shown = columns < 80 ? agents.slice(0, 3) : agents;
  return (
    <Box paddingX={2} gap={2} flexShrink={0}>
      <Text bold color={theme.accentAlt}>◈ AGENTS <Text color={theme.dim}>{active}/{agents.length} active</Text></Text>
      {shown.map((agent) => (
        <Text key={agent.id} color={agentColor(agent.status)}>
          {agentSymbol(agent.status)} <Text color={theme.assistant}>#{agent.id}</Text>
          {columns >= 90 ? <Text color={theme.dim}> {agent.role.split(" ")[0]?.toLowerCase()}</Text> : null}
          {columns >= 110 ? <Text color={theme.dim}> {agent.messages?.length ?? 0} msg</Text> : null}
        </Text>
      ))}
      {columns >= 75 ? <Text color={theme.dim}>/swarm chat &lt;id&gt; · /swarm open &lt;id&gt;</Text> : null}
    </Box>
  );
}

import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { PlanStep } from "../../types.js";
import { theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";

export function PlanPanel({ steps, maxVisible = 3 }: { steps: PlanStep[]; maxVisible?: number }) {
  const { columns = 100 } = useWindowSize();
  if (!steps.length || maxVisible <= 0) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  const active = steps.findIndex((step) => step.status === "in_progress");
  const start = Math.max(0, Math.min(active > 0 ? active - 1 : 0, steps.length - maxVisible));
  const visible = steps.slice(start, start + maxVisible);
  const filled = Math.round(done / steps.length * 10);
  return (
    <Box flexDirection="column" paddingX={2} marginTop={1} flexShrink={0}>
      <Text color={theme.dim} wrap="truncate-end"><Text bold color={theme.accent}>PLAN</Text>  <Text color={theme.ok}>{"━".repeat(filled)}</Text><Text color={theme.border}>{"─".repeat(10 - filled)}</Text>  {done}/{steps.length}{steps.length > visible.length && columns >= 65 ? `  ·  ${steps.length - visible.length} more` : ""}</Text>
      {visible.map((step, index) => (
        <Text key={`${index + start}-${step.step}`} color={step.status === "in_progress" ? theme.assistant : theme.dim} wrap="truncate-end">
          <Text color={step.status === "completed" ? theme.ok : step.status === "in_progress" ? theme.accent : theme.border}>{step.status === "completed" ? "✓" : step.status === "in_progress" ? "◉" : "○"}</Text> {terminalText(step.step).replace(/\n/g, " ")}
        </Text>
      ))}
    </Box>
  );
}

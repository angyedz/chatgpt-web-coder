import React from "react";
import { Box, Text } from "ink";
import type { PlanStep } from "../../types.js";
import { glyphs, theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";

export function PlanPanel({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null;
  const visible = steps.slice(0, 6);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginX={1}
      marginBottom={1}
    >
      <Box gap={1}>
        <Text bold color={theme.accent}>
          plan
        </Text>
        <Text dimColor>
          {steps.filter((step) => step.status === "completed").length}/{steps.length}
        </Text>
      </Box>
      {visible.map((step, index) => {
        const done = step.status === "completed";
        const active = step.status === "in_progress";
        return (
          <Box key={`${index}-${step.step}`} gap={1}>
            <Text color={done ? theme.ok : active ? theme.warn : theme.dim}>
              {done ? glyphs.planDone : active ? glyphs.planActive : glyphs.planPending}
            </Text>
            <Text color={active ? theme.warn : done ? theme.dim : undefined} strikethrough={done}>
              {terminalText(step.step)}
            </Text>
          </Box>
        );
      })}
      {steps.length > visible.length ? (
        <Text dimColor>+{steps.length - visible.length} more</Text>
      ) : null}
    </Box>
  );
}

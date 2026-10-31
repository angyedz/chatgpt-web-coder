import React from "react";
import { Box, Text } from "ink";
import type { ApprovalRequest } from "../../types.js";
import { firstLines } from "../../utils/text.js";
import { theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";

export function ApprovalPrompt({ request }: { request: ApprovalRequest }) {
  const summary = terminalText(request.summary);
  const controlsHidden = summary !== request.summary.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warn}
      paddingX={1}
      marginX={1}
      marginBottom={1}
    >
      <Box gap={1}>
        <Text bold color={theme.warn}>
          approval required
        </Text>
        <Text dimColor>·</Text>
        <Text bold>{terminalText(request.tool)}</Text>
      </Box>
      <Text>{firstLines(summary, 8, 300)}</Text>
      {controlsHidden ? <Text color={theme.warn}>Terminal control characters were hidden from this preview.</Text> : null}
      <Box marginTop={1} gap={2}>
        <Text color={theme.ok}>y allow</Text>
        <Text color={theme.error}>n deny</Text>
        <Text dimColor>Esc denies</Text>
      </Box>
    </Box>
  );
}

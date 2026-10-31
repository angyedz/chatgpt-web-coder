import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import type { ToolCallView } from "../../types.js";
import { firstLines, oneLine } from "../../utils/text.js";
import { glyphs, theme } from "../theme.js";
import wrapAnsi from "wrap-ansi";
import { terminalText } from "../terminal-text.js";

interface ToolCardProps {
  call: ToolCallView;
}

export function toolDisplayLines(call: ToolCallView, width: number, frame = 0): { text: string; color: string }[] {
  const color = call.status === "running" ? theme.accent : call.status === "ok" ? theme.ok : call.status === "denied" ? theme.warn : theme.error;
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const mark = call.status === "running" ? spinner[frame % spinner.length] : call.status === "ok" ? glyphs.check : call.status === "denied" ? glyphs.denied : glyphs.cross;
  const elapsed = call.endedAt ? ` · ${((call.endedAt - call.startedAt) / 1000).toFixed(1)}s` : call.status === "running" ? ` · ${Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000))}s` : "";
  const args = shortArgs(call.args);
  const header = `${mark} ${terminalText(call.name)}${args ? `  ${args}` : ""}${elapsed}`;
  const lines = [{ text: wrapAnsi(header, Math.max(1, width), { hard: true }).split("\n")[0] ?? "", color }];
  if (call.status === "error" || call.status === "denied") {
    const detail = firstLines(terminalText(call.error || call.output || "Tool failed"), 2, 140);
    for (const line of wrapAnsi(detail, Math.max(1, width - 2), { hard: true }).split("\n").slice(0, 2)) {
      lines.push({ text: `  ${line}`, color });
    }
  }
  return lines;
}

export function ToolCard({ call }: ToolCardProps) {
  const color =
    call.status === "running"
      ? theme.warn
      : call.status === "ok"
        ? theme.ok
        : call.status === "denied"
          ? theme.accentAlt
          : theme.error;

  const elapsed = call.endedAt
    ? `${((call.endedAt - call.startedAt) / 1000).toFixed(1)}s`
    : "";
  const args = shortArgs(call.args);
  const error = call.status === "error" || call.status === "denied";
  const detail = error
    ? firstLines(terminalText(call.error || call.output || "Tool failed"), 2, 140)
    : "";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box gap={1}>
        {call.status === "running" ? (
          <Spinner label="" />
        ) : (
          <Text color={color}>
            {call.status === "ok"
              ? glyphs.check
              : call.status === "denied"
                ? glyphs.denied
                : glyphs.cross}
          </Text>
        )}
        <Text bold color={color}>{terminalText(call.name)}</Text>
        {args ? <Text dimColor>{args}</Text> : null}
        {elapsed ? <Text dimColor>{elapsed}</Text> : null}
      </Box>
      {detail ? <Text color={color} dimColor>  {detail}</Text> : null}
    </Box>
  );
}

function shortArgs(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return oneLine(terminalText(String(value ?? "")), 48);
  }

  const args = value as Record<string, unknown>;
  const preferred = ["path", "file", "query", "url", "cmd", "command", "pattern"];
  for (const key of preferred) {
    const item = args[key];
    if (typeof item === "string" && item.trim()) {
      const compact = terminalText(item).replace(/\s+/g, " ").trim();
      return oneLine(compact, key === "cmd" || key === "command" ? 52 : 64);
    }
  }
  return "";
}

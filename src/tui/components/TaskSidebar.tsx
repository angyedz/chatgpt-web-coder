import React from "react";
import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";
import type { Goal } from "../../runtime/goals.js";
import type { PlanStep, SubagentSnapshot } from "../../types.js";
import { agentColor, agentSymbol } from "./SubagentStrip.js";
import { terminalText } from "../terminal-text.js";
import { theme } from "../theme.js";

interface Notice { id: number; level: "info" | "warn" | "error"; text: string }
interface TaskSidebarProps {
  width: number;
  height: number;
  goal?: Goal;
  steps: PlanStep[];
  notices: Notice[];
  jobs: number;
  timers: number;
  nextTimerSeconds: number;
  agents?: SubagentSnapshot[];
}
interface Line { text: string; color?: string; bold?: boolean }

function wrapped(value: string, width: number, limit: number): string[] {
  const text = terminalText(value).replace(/\s+/g, " ").trim();
  const lines = wrapAnsi(text || " ", Math.max(1, width), { hard: true, trim: true }).split("\n");
  if (lines.length > limit) {
    const last = lines[limit - 1] ?? "";
    return [...lines.slice(0, limit - 1), `${Array.from(last).slice(0, Math.max(0, width - 1)).join("")}…`];
  }
  return lines;
}

export function TaskSidebar({ width, height, goal, steps, notices, jobs, timers, nextTimerSeconds, agents = [] }: TaskSidebarProps) {
  const inner = Math.max(1, width - 4);
  const capacity = Math.max(0, height - 2);
  const rows: Line[] = [{ text: "◆  WORKSPACE", color: theme.accent, bold: true }];
  if (capacity >= 20) rows.push({ text: " " });

  if (goal) {
    rows.push({ text: `◇  GOAL  ·  ${goal.status}`, color: goal.status === "active" ? theme.accent : goal.status === "complete" ? theme.ok : theme.warn, bold: true });
    for (const line of wrapped(goal.objective, inner, 2)) rows.push({ text: line, color: theme.assistant });
    if (capacity >= 20) rows.push({ text: " " });
  }
  if (agents.length) {
    const running = agents.filter((agent) => ["preparing", "running"].includes(agent.status)).length;
    rows.push({ text: `◈  AGENTS  ·  ${running}/${agents.length} active`, color: theme.accentAlt, bold: true });
    for (const agent of agents) {
      const name = wrapped(agent.role, Math.max(1, inner - 12), 1)[0] ?? "";
      rows.push({ text: `${agentSymbol(agent.status)} #${agent.id} ${name} · ${agent.toolCount} tools`, color: agentColor(agent.status) });
    }
    rows.push({ text: "  /swarm status · /swarm results", color: theme.dim });
    if (capacity >= 20) rows.push({ text: " " });
  }
  if (jobs || timers) {
    rows.push({ text: "◉  BACKGROUND", color: theme.accentAlt, bold: true });
    const details = [jobs ? `${jobs} job${jobs === 1 ? "" : "s"}` : "", timers ? `${timers} timer${timers === 1 ? "" : "s"} · ${nextTimerSeconds}s` : ""].filter(Boolean).join("  ·  ");
    rows.push({ text: details, color: theme.assistant });
    if (capacity >= 20) {
      rows.push({ text: [jobs ? "/jobs" : "", timers ? "/timers" : ""].filter(Boolean).join("  ·  "), color: theme.dim });
      rows.push({ text: " " });
    }
  }

  const noticeRows: Line[] = notices.slice(-2).map((notice) => ({
    text: `${notice.level === "error" ? "✗" : notice.level === "warn" ? "!" : "·"} ${wrapped(notice.text, Math.max(1, inner - 2), 1)[0] ?? ""}`,
    color: notice.level === "error" ? theme.error : notice.level === "warn" ? theme.warn : theme.dim,
  }));
  const reservedNotices = noticeRows.length ? Math.min(noticeRows.length + 1, Math.max(0, capacity - rows.length - (steps.length ? 2 : 0))) : 0;
  const planBudget = Math.max(0, capacity - rows.length - reservedNotices);
  if (steps.length && planBudget >= 2) {
    const done = steps.filter((step) => step.status === "completed").length;
    const filled = Math.round(done / steps.length * 8);
    rows.push({ text: `PLAN  ${done}/${steps.length}  ${"━".repeat(filled)}${"─".repeat(8 - filled)}`, color: theme.accent, bold: true });
    const active = steps.findIndex((step) => step.status === "in_progress");
    const visibleCount = Math.min(steps.length, Math.max(1, planBudget - 1 - (steps.length > planBudget - 1 ? 1 : 0)));
    const start = Math.max(0, Math.min(active > 0 && visibleCount > 1 ? active - 1 : Math.max(0, active), steps.length - visibleCount));
    const visible = steps.slice(start, start + visibleCount);
    const omitted = steps.length - visible.length;
    const planEnd = capacity - reservedNotices;
    for (const [index, step] of visible.entries()) {
      const remainingSteps = visible.length - index - 1;
      const available = Math.max(1, planEnd - rows.length - remainingSteps - (omitted ? 1 : 0));
      const parts = wrapped(step.step, Math.max(1, inner - 2), Math.min(2, available));
      const color = step.status === "completed" ? theme.ok : step.status === "in_progress" ? theme.assistant : theme.dim;
      const icon = step.status === "completed" ? "✓" : step.status === "in_progress" ? "◉" : "○";
      parts.forEach((part, partIndex) => rows.push({ text: `${partIndex ? " " : icon} ${part}`, color }));
    }
    if (omitted && rows.length < planEnd) rows.push({ text: `  … ${omitted} more`, color: theme.dim });
  }
  if (reservedNotices) {
    if (reservedNotices > 1) rows.push({ text: "NOTICES", color: theme.dim, bold: true });
    rows.push(...noticeRows.slice(-(reservedNotices > 1 ? reservedNotices - 1 : 1)));
  }
  return (
    <Box width={width} height={height} borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column" flexShrink={0} overflow="hidden">
      {rows.slice(0, capacity).map((line, index) => <Text key={index} color={line.color} bold={line.bold} wrap="truncate-end">{line.text || " "}</Text>)}
    </Box>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useWindowSize } from "ink";
import type { TurnPhase } from "../../types.js";
import { theme } from "../theme.js";
import { phaseLabel } from "./StatusBar.js";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function ActivityBar({ phase, startedAt, paused = false }: { phase: TurnPhase; startedAt?: number; paused?: boolean }) {
  const { columns = 100 } = useWindowSize();
  const [tick, setTick] = useState(0);
  const reducedMotion = process.env.CHATGPT_CODER_REDUCED_MOTION === "1" || process.env.CI === "true";
  useEffect(() => {
    if (reducedMotion || paused) return;
    const timer = setInterval(() => setTick((value) => value + 1), 140);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [reducedMotion, paused]);
  const elapsedRef = useRef(0);
  if (!paused) elapsedRef.current = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const elapsed = elapsedRef.current;
  const stationary = phase === "waiting-approval" || phase === "waiting-login" || phase === "cancelling";
  const color = phase === "error" ? theme.error : stationary ? theme.warn : theme.accent;
  const frame = reducedMotion || stationary ? "◌" : frames[tick % frames.length];
  const position = tick % 10;
  const track = Array.from({ length: 10 }, (_, index) => index === position ? "━" : "─").join("");
  return (
    <Box paddingX={2} gap={1} flexShrink={0}>
      <Text color={color}>{frame}</Text>
      <Text color={color}>{phaseLabel[phase]}</Text>
      {columns >= 70 && !stationary && !reducedMotion ? <Text color={theme.border}>{track}</Text> : null}
      {startedAt ? <Text color={theme.dim}>{elapsed}s</Text> : null}
      {columns >= 72 && phase !== "updating" && phase !== "downloading-update" && phase !== "cancelling" ? <Text color={theme.dim}>{paused ? "· Esc return" : "· Esc stop"}</Text> : null}
    </Box>
  );
}

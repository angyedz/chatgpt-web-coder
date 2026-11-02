// Calm, high-contrast terminal palette influenced by modern coding agents.
export const theme = {
  accent: "#8DB7FF",
  accentAlt: "#B9A3F5",
  ok: "#7DD8B0",
  warn: "#F3C77C",
  error: "#F18FA5",
  dim: "#99A4B7",
  user: "#C4D8F8",
  assistant: "#F0F3F8",
  border: "#647186",
  selected: "#8DB7FF",
} as const;

export const glyphs = {
  dot: "●",
  dotEmpty: "○",
  check: "✓",
  cross: "✗",
  denied: "⊘",
  bullet: "•",
  arrow: "›",
  cursor: "▌",
  planPending: "○",
  planActive: "◉",
  planDone: "●",
} as const;

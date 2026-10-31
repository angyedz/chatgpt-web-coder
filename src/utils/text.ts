export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n... [truncated ${text.length - max} chars] ...\n\n${text.slice(-tail)}`;
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function firstLines(text: string, count = 8, max = 240): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, count)
    .map((line) => (line.length > max ? `${line.slice(0, max - 1)}…` : line))
    .join("\n");
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

export function safeJson(value: unknown, max = 800): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return truncate(json, max);
  } catch {
    return String(value);
  }
}

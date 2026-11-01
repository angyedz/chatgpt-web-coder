import React, { useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import { theme } from "../theme.js";
import { terminalText } from "../terminal-text.js";
import type { TurnPhase } from "../../types.js";
import { imagePathFromPaste, readWindowsClipboardText } from "../../runtime/attachments.js";

interface InputBarProps {
  disabled: boolean;
  phase: TurnPhase;
  inputKey: number;
  onSubmit: (value: string) => void | boolean;
  placeholder: string;
  initialHistory?: string[];
  hasAttachments?: boolean;
  onPasteImage?: (value: string) => Promise<boolean>;
  onPasteClipboardImage?: () => Promise<boolean>;
  onPasteError?: (message: string) => void;
}

interface Draft { value: string; cursor: number }

function previousCharacter(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const previous = value.charCodeAt(cursor - 1);
  return previous >= 0xdc00 && previous <= 0xdfff && cursor > 1 ? cursor - 2 : cursor - 1;
}
function nextCharacter(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const code = value.codePointAt(cursor) ?? 0;
  return cursor + (code > 0xffff ? 2 : 1);
}

export function InputBar({ disabled, phase, onSubmit, placeholder, initialHistory = [], hasAttachments = false, onPasteImage, onPasteClipboardImage, onPasteError }: InputBarProps) {
  const { columns = 100 } = useWindowSize();
  const history = useRef(initialHistory.slice(-200));
  const historyIndex = useRef<number | null>(null);
  const savedDraft = useRef<Draft>({ value: "", cursor: 0 });
  const current = useRef<Draft>({ value: "", cursor: 0 });
  const [draft, setDraft] = useState(current.current);
  const pasteQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingPastes = useRef(0);
  const [pasting, setPasting] = useState(false);
  const update = (next: Draft) => { current.current = next; setDraft(next); };
  const insert = (value: string) => {
    if (!value) return;
    const state = current.current;
    update({ value: state.value.slice(0, state.cursor) + value + state.value.slice(state.cursor), cursor: state.cursor + value.length });
  };
  const enqueuePaste = (action: () => Promise<void>) => {
    pendingPastes.current++;
    setPasting(true);
    pasteQueue.current = pasteQueue.current.then(action).catch((error: unknown) => {
      onPasteError?.(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      pendingPastes.current--;
      if (!pendingPastes.current) setPasting(false);
    });
  };
  const paste = (value: string) => {
    if (!value) { enqueuePaste(async () => { await onPasteClipboardImage?.(); }); return; }
    if (!imagePathFromPaste(value) || !onPasteImage) { insert(value); return; }
    enqueuePaste(async () => { if (!(await onPasteImage(value))) insert(value); });
  };
  usePaste(paste, { isActive: !disabled });
  useInput((input, key) => {
    const state = current.current;
    if (key.ctrl && input.toLowerCase() === "v") {
      enqueuePaste(async () => {
        if (!(await onPasteClipboardImage?.())) insert(await readWindowsClipboardText());
      });
      return;
    }
    if (input.length > 1 && imagePathFromPaste(input)) { paste(input); return; }
    // Some terminals deliver an unbracketed multiline paste as a single input.
    if (input.length > 1 && /[\r\n]/.test(input)) { insert(input); return; }
    if (key.upArrow && history.current.length) {
      if (historyIndex.current === null) { savedDraft.current = state; historyIndex.current = history.current.length - 1; }
      else historyIndex.current = Math.max(0, historyIndex.current - 1);
      const value = history.current[historyIndex.current] ?? "";
      update({ value, cursor: value.length });
      return;
    }
    if (key.downArrow && historyIndex.current !== null) {
      const next = historyIndex.current + 1;
      const atDraft = next >= history.current.length;
      historyIndex.current = atDraft ? null : next;
      const restored = atDraft ? savedDraft.current : { value: history.current[next] ?? "", cursor: (history.current[next] ?? "").length };
      update(restored);
      return;
    }
    if (key.ctrl && input === "j") { insert("\n"); return; }
    if (key.ctrl && input === "a") { update({ ...state, cursor: 0 }); return; }
    if (key.ctrl && input === "e") { update({ ...state, cursor: state.value.length }); return; }
    if (key.ctrl || key.meta || key.pageUp || key.pageDown || key.escape || key.tab) return;
    if (key.return && key.shift) { insert("\n"); return; }
    if (key.return) {
      if (pendingPastes.current) return;
      if (!state.value.trim() && !hasAttachments) return;
      if (onSubmit(state.value) === false) return;
      if (state.value.trim() && (!state.value.trimStart().startsWith("/") || /^\s*\/btw\s/i.test(state.value) || state.value.length > 12_000 && !/^\s*\/goal(?:\s|$)/i.test(state.value))) history.current = [...history.current.slice(-199), state.value];
      historyIndex.current = null;
      savedDraft.current = { value: "", cursor: 0 };
      update({ value: "", cursor: 0 });
      return;
    }
    if (key.leftArrow) { update({ ...state, cursor: previousCharacter(state.value, state.cursor) }); return; }
    if (key.rightArrow) { update({ ...state, cursor: nextCharacter(state.value, state.cursor) }); return; }
    if (key.home) { update({ ...state, cursor: 0 }); return; }
    if (key.end) { update({ ...state, cursor: state.value.length }); return; }
    if (key.backspace && state.cursor > 0) {
      const start = previousCharacter(state.value, state.cursor);
      update({ value: state.value.slice(0, start) + state.value.slice(state.cursor), cursor: start });
      return;
    }
    if (key.delete && state.cursor < state.value.length) {
      update({ value: state.value.slice(0, state.cursor) + state.value.slice(nextCharacter(state.value, state.cursor)), cursor: state.cursor });
      return;
    }
    if (input) insert(input);
  }, { isActive: !disabled });

  const marker = draft.value.length > 512 ? `[${draft.value.length.toLocaleString()} chars] ` : "";
  const available = Math.max(5, columns - marker.length - 11);
  const left = terminalText(draft.value.slice(Math.max(0, draft.cursor - available * 2), draft.cursor)).replace(/\n/g, " ↵ ");
  const rightCursor = nextCharacter(draft.value, draft.cursor);
  const selected = terminalText(draft.value.slice(draft.cursor, rightCursor)).replace(/\n/g, "↵") || " ";
  const right = terminalText(draft.value.slice(rightCursor, rightCursor + available * 2)).replace(/\n/g, " ↵ ");
  const visibleLeft = left.slice(-Math.max(0, available - Math.min(right.length, Math.floor(available / 3)) - 1));
  const visibleRight = right.slice(0, Math.max(0, available - visibleLeft.length - 1));
  return (
    <Box borderStyle="round" borderColor={disabled ? theme.border : theme.accent} paddingX={1} marginX={1}>
      {disabled ? <Text color={phase === "cancelling" ? theme.warn : theme.dim} wrap="truncate-end">{phase === "cancelling" ? "Stopping…" : phase === "uploading" ? "Uploading attachments…  ·  Esc to stop" : phase === "downloading-update" ? "Downloading update…  ·  please wait" : phase === "updating" ? "Updating…  ·  please wait" : phase === "waiting-approval" ? "Respond to the approval above" : "Working…  ·  Ctrl+D status  ·  Esc to stop"}</Text> : (
        <Box gap={1}><Text bold color={theme.accent}>›</Text><Text wrap="truncate-end">{marker ? <Text color={theme.dim}>{marker}</Text> : null}{draft.value ? <>{visibleLeft}<Text inverse>{selected}</Text>{visibleRight}</> : <><Text inverse> </Text><Text color={theme.dim}>{pasting ? "Attaching image…" : placeholder}</Text></>}</Text></Box>
      )}
    </Box>
  );
}

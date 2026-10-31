import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { theme } from "../theme.js";
import type { TurnPhase } from "../../types.js";

interface InputBarProps {
  disabled: boolean;
  phase: TurnPhase;
  inputKey: number;
  onSubmit: (value: string) => void;
  placeholder: string;
  initialHistory?: string[];
}

export function InputBar({ disabled, phase, inputKey, onSubmit, placeholder, initialHistory = [] }: InputBarProps) {
  const history = useRef<string[]>(initialHistory.slice(-200));
  const historyIndex = useRef<number | null>(null);
  const currentValue = useRef("");
  const savedDraft = useRef("");
  const [seed, setSeed] = useState({ value: "", revision: 0 });

  useInput((_input, key) => {
    if (key.upArrow && history.current.length > 0) {
      if (historyIndex.current === null) {
        savedDraft.current = currentValue.current;
        historyIndex.current = history.current.length - 1;
      } else {
        historyIndex.current = Math.max(0, historyIndex.current - 1);
      }
      const value = history.current[historyIndex.current] ?? "";
      currentValue.current = value;
      setSeed((previous) => ({ value, revision: previous.revision + 1 }));
    } else if (key.downArrow && historyIndex.current !== null) {
      const nextIndex = historyIndex.current + 1;
      const atDraft = nextIndex >= history.current.length;
      historyIndex.current = atDraft ? null : nextIndex;
      const value = atDraft ? savedDraft.current : (history.current[nextIndex] ?? "");
      currentValue.current = value;
      setSeed((previous) => ({ value, revision: previous.revision + 1 }));
    }
  }, { isActive: !disabled });

  const submit = (value: string) => {
    const text = value.trim();
    // Slash commands can contain credentials, so keep only chat messages.
    if (text && !text.startsWith("/")) {
      history.current = [...history.current.slice(-199), text];
    }
    historyIndex.current = null;
    currentValue.current = "";
    savedDraft.current = "";
    setSeed((previous) => ({ value: "", revision: previous.revision + 1 }));
    onSubmit(value);
  };

  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? theme.border : theme.accent}
      paddingX={1}
      marginX={1}
    >
      {disabled ? (
        <Text color={phase === "cancelling" ? theme.warn : theme.dim}>
          {phase === "cancelling" ? "Stopping…" : phase === "downloading-update" ? "Downloading update…  ·  please wait" : phase === "updating" ? "Updating…  ·  please wait" : phase === "waiting-approval" ? "Respond to the approval above" : "Working…  ·  Ctrl+D status  ·  Esc to stop"}
        </Text>
      ) : (
        <Box gap={1}>
          <Text bold color={theme.accent}>
            ›
          </Text>
          <TextInput
            key={`${inputKey}-${seed.revision}`}
            defaultValue={seed.value}
            placeholder={placeholder}
            onChange={(value) => { currentValue.current = value; }}
            onSubmit={submit}
          />
        </Box>
      )}
    </Box>
  );
}

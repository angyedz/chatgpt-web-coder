import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";
import { disableMouse } from "./terminal-modes.js";
import { copySelection, type ScreenSelection } from "./screen-selection.js";

const enableMouse = "\u001b[?1002h\u001b[?1006h";

interface WheelArea {
  top: number;
  height: number;
  width: number;
}

// Observe input without consuming it, so Ink still handles keyboard and paste.
export function useMouseWheel(area: WheelArea, onWheel: (direction: 1 | -1) => void, selection?: ScreenSelection, onCopyError?: (message: string) => void): void {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const current = useRef({ area, onWheel, selection, onCopyError });
  current.current = { area, onWheel, selection, onCopyError };

  useEffect(() => {
    if (!(stdin as NodeJS.ReadStream).isTTY || !(stdout as NodeJS.WriteStream).isTTY || process.env.TERM === "dumb") return;
    let pending = "";
    let inPaste = false;
    let dragging = false;

    const onData = (chunk: string | Buffer) => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (pending.length) {
        const escape = pending.indexOf("\u001b");
        if (escape < 0) { if (!inPaste && !dragging) current.current.selection?.clear(); pending = ""; break; }
        if (escape > 0 && !inPaste && !dragging) current.current.selection?.clear();
        pending = pending.slice(escape);
        if (pending.length < 6 && ("\u001b[200~".startsWith(pending) || "\u001b[201~".startsWith(pending))) break;
        if (pending.startsWith("\u001b[200~")) { inPaste = true; pending = pending.slice(6); continue; }
        if (pending.startsWith("\u001b[201~")) { inPaste = false; pending = pending.slice(6); continue; }
        if (pending.startsWith("\u001b[<")) {
          const event = /^\u001b\[<(\d{1,4});(\d{1,5});(\d{1,5})([Mm])/.exec(pending);
          if (event) {
            pending = pending.slice(event[0].length);
            const code = Number(event[1]);
            const x = Number(event[2]);
            const y = Number(event[3]);
            const { area: bounds, onWheel: scroll, selection: screen, onCopyError: reportError } = current.current;
            if (!inPaste && event[4] === "M" && (code & 0xc0) === 0x40 && (code & 0x03) < 2 && x >= 1 && x <= bounds.width && y > bounds.top && y <= bounds.top + bounds.height) {
              dragging = false;
              screen?.clear();
              scroll((code & 0x03) === 0 ? 1 : -1);
            } else if (!inPaste && screen && (code & 0xc0) === 0 && (code & 3) === 0) {
              if (event[4] === "M" && (code & 32) === 0) { dragging = true; screen.start({ x, y }); }
              else if (event[4] === "M" && dragging && (code & 32) !== 0) screen.move({ x, y });
              else if (event[4] === "m" && dragging) {
                dragging = false;
                const selected = screen.end({ x, y });
                if (selected.trim()) void copySelection(selected, stdout as NodeJS.WriteStream).catch((error: unknown) => reportError?.(`Clipboard: ${error instanceof Error ? error.message : String(error)}`));
              }
            }
            continue;
          }
          if (pending.length < 64 && /^\u001b\[<[\d;]*$/.test(pending)) break;
        }
        pending = pending.slice(1);
      }
    };

    stdin.on("data", onData);
    stdout.write(enableMouse);
    return () => {
      stdin.removeListener("data", onData);
      stdout.write(disableMouse);
    };
  }, [stdin, stdout]);
}

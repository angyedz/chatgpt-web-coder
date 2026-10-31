import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";

const enableMouse = "\u001b[?1000h\u001b[?1006h";
export const disableMouse = "\u001b[?1000l\u001b[?1006l";

interface WheelArea {
  top: number;
  height: number;
  width: number;
}

// Ink consumes mouse sequences before useInput. Observe the same stdin chunks
// without reading from the stream, so Ink still owns keyboard input and paste.
export function useMouseWheel(area: WheelArea, onWheel: (direction: 1 | -1) => void): void {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const current = useRef({ area, onWheel });
  current.current = { area, onWheel };

  useEffect(() => {
    if (!(stdin as NodeJS.ReadStream).isTTY || !(stdout as NodeJS.WriteStream).isTTY || process.env.TERM === "dumb") return;
    let pending = "";
    let inPaste = false;

    const onData = (chunk: string | Buffer) => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (pending.length) {
        const escape = pending.indexOf("\u001b");
        if (escape < 0) { pending = ""; break; }
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
            const { area: bounds, onWheel: scroll } = current.current;
            if (!inPaste && event[4] === "M" && (code & 0xc0) === 0x40 && (code & 0x03) < 2 && x >= 1 && x <= bounds.width && y > bounds.top && y <= bounds.top + bounds.height) {
              scroll((code & 0x03) === 0 ? 1 : -1);
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

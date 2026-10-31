import { readFileSync } from "node:fs";

export const APP_VERSION: string = (() => {
  try {
    const data = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof data.version === "string" ? data.version : "unknown";
  } catch {
    return "unknown";
  }
})();

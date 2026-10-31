import { loadConfig } from "../config.js";
import { createRuntime } from "../runtime/context.js";
import { McpHost } from "./server.js";
import { terminalText } from "../tui/terminal-text.js";

const config = loadConfig(process.cwd());
config.approvalMode = "never";

const runtime = createRuntime(config);
runtime.events.on((event) => {
  if (event.type === "tool-start") {
    console.log(`[tool] ${terminalText(event.call.name)}`);
  } else if (event.type === "tool-end") {
    console.log(`[tool] ${terminalText(event.call.name)}: ${event.call.status}`);
  } else if (event.type === "notice") {
    console.log(`[${event.level}] ${terminalText(event.text)}`);
  }
});

const host = new McpHost(runtime.context, config.mcp);
const url = await host.start();
console.log(`chatgpt-coder MCP server: ${terminalText(url)}`);
console.log(`Health: http://${terminalText(config.mcp.host)}:${host.port}/healthz`);
console.log("Approval mode: never (standalone)");

const shutdown = async () => {
  runtime.timers.dispose();
  await runtime.exec.dispose();
  await host.stop();
  await runtime.externalMcp.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

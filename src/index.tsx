#!/usr/bin/env node
import React from "react";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { render } from "ink";
import { Orchestrator } from "./agent/orchestrator.js";
import { exampleConfig, loadConfig } from "./config.js";
import { McpHost } from "./mcp/server.js";
import { createRuntime } from "./runtime/context.js";
import { runDoctor } from "./runtime/doctor.js";
import { App } from "./tui/App.js";
import { terminalText } from "./tui/terminal-text.js";
import { installTunnelClient } from "./runtime/install-tunnel.js";
import { APP_VERSION } from "./runtime/version.js";
import { disableMouse } from "./tui/terminal-modes.js";
import { ScreenSelection } from "./tui/screen-selection.js";

const HELP = `chatgpt-coder — ChatGPT Web drives Codex-style local tools over MCP.

Usage:
  chatgpt-coder [options]

Options:
  --model <label>     Select a ChatGPT model by its visible label.
  --connector <name>  ChatGPT MCP connector name (default: chatgpt-coder).
  --no-connector      Do not attach the connector (browser-only mode).
  --saved-chat        Use a normal saved chat instead of a temporary chat.
  --yolo              Never ask for local approval (same as /approval never).
  --headless          Run Chromium headless (login must already exist).
  --no-tunnel         Do not start tunnel-client (tools still work locally).
  --init              Create harness.config.json from the example.
  --doctor            Run configuration and connectivity checks, then exit.
  --install-tunnel    Download and verify the tunnel client, then exit.
  --help, -h          Show this help.
  --version, -v       Show the version.

Environment:
  CONTROL_PLANE_API_KEY   Runtime key for the OpenAI Secure MCP Tunnel.
  TUNNEL_ID               Tunnel id from the OpenAI Platform.
  SEARXNG_URL             SearXNG base URL (JSON API enabled).
  CHATGPT_CONNECTOR_NAME  MCP connector name (default: chatgpt-coder).
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`chatgpt-coder ${APP_VERSION}`);
    return;
  }
  if (args.includes("--install-tunnel")) {
    await installTunnelClient((message) => console.log(terminalText(message)));
    return;
  }

  const workspace = process.cwd();
  if (args.includes("--init")) {
    const target = path.join(workspace, "harness.config.json");
    if (existsSync(target)) {
      console.log(`Already exists: ${terminalText(target)}`);
      return;
    }
    writeFileSync(target, `${exampleConfig()}\n`, "utf8");
    console.log(`Created ${terminalText(target)}`);
    return;
  }

  const config = loadConfig(workspace);
  const model = valueOf(args, "--model");
  if (model) config.browser.modelLabel = model;
  const connector = valueOf(args, "--connector");
  if (connector) config.browser.connectorName = connector;
  if (args.includes("--no-connector")) config.browser.attachConnector = false;
  if (args.includes("--saved-chat")) config.browser.useTemporaryChat = false;
  if (args.includes("--yolo")) config.approvalMode = "never";
  if (args.includes("--headless")) config.browser.headless = true;
  if (args.includes("--no-tunnel")) config.tunnel.enabled = false;

  if (args.includes("--doctor")) {
    const runtime = createRuntime(config);
    runtime.approvals.mode = "never";
    const host = new McpHost(runtime.context, config.mcp);
    const url = await host.start();
    const result = await runDoctor(config, url, { browserOpen: false });
    console.log(terminalText(result.lines.join("\n")));
    await host.stop();
    await runtime.exec.dispose();
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (!process.stdin.isTTY) {
    console.error("chatgpt-coder needs an interactive terminal (TTY) for its UI.");
    process.exit(1);
  }

  const orchestrator = new Orchestrator(config);
  await orchestrator.start();

  // A previous full-screen program may have left mouse reporting enabled.
  // Restore native terminal selection before mounting the UI.
  if (process.stdout.isTTY && process.env.TERM !== "dumb") process.stdout.write(disableMouse);
  const selection = process.stdout.isTTY && process.env.TERM !== "dumb" ? new ScreenSelection(process.stdout) : undefined;
  const app = render(<App orchestrator={orchestrator} selection={selection} />, {
    alternateScreen: true,
    // Redrawing the whole screen destroys terminal selections on every frame.
    incrementalRendering: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const onSigterm = () => {
    app.unmount();
  };
  process.once("SIGTERM", onSigterm);

  try {
    await app.waitUntilExit();
  } finally {
    process.off("SIGTERM", onSigterm);
    selection?.dispose();
    if (process.stdout.isTTY && process.env.TERM !== "dumb") process.stdout.write(disableMouse);
    await orchestrator.shutdown();
  }
  process.stdout.write("Bye\n");
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

main().catch((error: unknown) => {
  console.error(terminalText(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(1);
});

# chatgpt-coder — reference

[Русская версия](REFERENCE.md) · [English overview](../README.en.md)

chatgpt-coder is a local coding harness: **ChatGPT Web provides the reasoning, and your computer runs the tools.** The harness opens ChatGPT in Chromium, sends the task and tool contract, and streams the result to its terminal UI. ChatGPT can call local tools through an MCP connector and OpenAI Secure MCP Tunnel.

## Features

- Local shell, file, patch, Git, image, and web tools
- Streaming TUI with tool cards, plans, approvals, and runtime status
- Workspace-scoped file operations and asynchronous shell sessions
- Timers, background jobs, and explicit subagents
- Automatic connector attachment and configurable context compaction
- Telegram control from a linked private chat

## Requirements

Windows 10/11, macOS, or Linux. The Windows installer includes Node.js and Git; source development requires Node.js 22+. ChatGPT browser use requires an account. Local MCP tools also require a custom MCP connector, an OpenAI Secure MCP Tunnel, and a runtime key with **Tunnels Read + Use** permissions. Web search requires a reachable SearXNG JSON API.

## Quick start

### Windows installation

Run `install.cmd` from the extracted project folder. Open a new terminal, change to your project, and run `chatgpt-coder`. Sign in to ChatGPT in Chromium and configure the tunnel with `/connect`. See the [Windows installation guide](INSTALL-WINDOWS.en.md).

### Run from source

```powershell
npm install
npm run setup
Copy-Item .env.example .env
# Set TUNNEL_ID and CONTROL_PLANE_API_KEY if using the MCP tunnel
npm run dev
```

Useful checks: `npm run doctor`, `npm run typecheck`, and `npm test`.

## Secure MCP Tunnel and ChatGPT connector

1. Create a tunnel in [OpenAI Platform](https://platform.openai.com/settings/organization/tunnels).
2. Create a runtime API key with **Tunnels Read + Use**.
3. In the harness, run `/connect tunnel tunnel_...` and `/connect key <runtime-key>`.
4. In ChatGPT settings, add a custom MCP connector with **Connection: Tunnel**, select the tunnel, and install the connector. See the [OpenAI setup guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
5. Set the connector name to match `browser.connectorName` (default: `chatgpt-coder`).
6. Wait for the `tunnel` indicator to turn green. Temporary chats must use the **Personalized** setting to access connectors.

Use `/doctor`, `/tunnel`, and `/status` for diagnostics. Set `browser.attachConnector` to `false` for browser-only use.

## Tools

Tools include `exec_command` and `write_stdin` for shell sessions; `apply_patch`; `read_file`, `list_dir`, `glob`, and `grep`; `git_status`, `git_diff`, and `git_log`; `view_image`; `web_search` and `web_fetch`; plus timers, background tasks, and SSH tools. Use `get_workspace_info` to inspect the configured environment and available tools. Long-running commands return a `session_id` that can be polled with `write_stdin`.

File tools are confined to the selected workspace. Shell commands run as the current OS user. By default, shell commands and writes require approval; `/approval never` disables those prompts.

## TUI commands

| Command | Description |
| --- | --- |
| `/help`, `/status`, `/doctor` | Help, runtime status, and diagnostics |
| `/connect` | Configure the tunnel, connector, or browser |
| `/mcp list`, `/mcp add`, `/mcp remove` | Manage external MCP servers |
| `/sessions`, `/session <id>`, `/session new` | List, switch, or create sessions |
| `/new [path]`, `/new --create <path>` | Open a session in a folder or create one |
| `/session rename <name>`, `/session info` | Rename or inspect the selected session |
| `/folders` | List known workspace folders |
| `/attach <path>`, `/attachments`, `/detach <id>` | Attach and manage files |
| `/goal <task>`, `/goal status`, `/goal resume`, `/goal cancel` | Start, inspect, resume, or cancel a goal |
| `/swarm start <1-5> <task>` | Explicitly start subagents |
| `/swarm status`, `/swarm inspect <id>`, `/swarm chat <id>` | Inspect subagent status, details, or conversation |
| `/swarm message <id> <text>`, `/swarm stop <id\|all>` | Send a follow-up or stop subagents |
| `/swarm history`, `/swarm report <run-id>` | Review saved subagent runs |
| `/model`, `/effort` | List ChatGPT model and reasoning options |
| `/timer <duration> [label] [-- command]` | Schedule a reminder or command |
| `/timers`, `/jobs`, `/job <id>` | Inspect timers and background processes |
| `/btw <question>`, `/btw cancel` | Ask or cancel a separate side question |
| `/context <tokens>`, `/compact` | Set context target or compact manually |
| `/skills`, `/agents` | List skills and project instructions |
| `/update check`, `/update latest`, `/update apply` | Check, download, and apply an update |
| `/update rollback` | Roll back to a previous Windows installation |

Subagents are never started automatically. Each gets a separate background browser tab and project copy. Secret files are excluded. When work finishes, changes are copied back only if the destination files have not changed concurrently. Copies and reports remain available for review.

Starting a group also opens one dedicated orchestrator tab. The orchestrator chooses task-specific roles and assignments for the requested number of workers, without a fixed role list. It reviews progress about every 30 seconds and after worker completion, and may issue revisions, verification or dependent assignments. Instructions for busy workers are queued. Before follow-up work, unchanged files in a worker copy are refreshed from integrated parent changes; conflicting local edits are preserved. The group's completion requires the orchestrator's final review, not just idle workers. Its status and findings appear in `/swarm status` and saved reports. Stopping the whole group also stops the orchestrator.

The orchestrator controls the group exclusively through the `update_swarm` MCP tool. Assistant JSON is never parsed or executed. Assignments take effect on a successful call without waiting for the prose response to end. Stale and duplicate calls are rejected; the tool is available only to the active coordinator. A missing call triggers another review in about 30 seconds while preserving existing tasks. Connector setup failures before submission are retried safely. Unused workers do not become `failed` because the coordinator fails. Browser errors, quiet agents and waiting for the group do not automatically set the user goal to `blocked`.

Unused workers can remain `idle` with a recorded dependency or capacity reason. The orchestrator can assign them later instead of inventing redundant tasks to occupy every slot.

## Telegram

Create a bot with [@BotFather](https://t.me/BotFather), then run `/telegram setup` locally and enter the token in the protected prompt. Start a private chat with the bot and pair it using the one-time words shown by the harness. The pairing phrase expires after 10 minutes and has a limited number of attempts.

The Telegram interface is in English. It supports tasks, session switching, goals, model and effort selection, subagents, timers, updates, and approval buttons. Ordinary messages are treated as tasks; slash commands are passed to the harness. Long responses are delivered in additional messages through a durable local outbox.

Only the linked Telegram account in its private chat can control the harness. Groups and other accounts are ignored. `/telegram stop` stops polling while retaining the link; `/telegram start` reconnects; `/telegram unlink` removes the local token and link. Revoke a compromised token with BotFather.

## Windows updates

`/update check` checks the configured channel, `/update latest` downloads a verified release, and `/update apply` installs it after confirmation. Use `/update settings` to inspect channels and update preferences. A local ZIP can be selected with `/update <path>` or the picker. `/update rollback` restores a previous installed release.

To build an update ZIP from source:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-update.ps1
```

## Sessions, timers, and background work

Sessions are saved per workspace. Use `/sessions` to list them, `/session <id>` to switch, `/session new` to create one in the current folder, or `/new <absolute-path>` to open a session for another project. Model and reasoning choices are kept per session. Background jobs and timers can be inspected with `/jobs` and `/timers`.

Waiting for response startup and generation has no overall timeout, even during silent reasoning. Elapsed time alone does not stop a turn or block its goal. The legacy `browser.responseTimeoutMs` setting controls inactivity reminders; `0` disables those reminders. Use Esc or `/stop` to cancel.

Automatic stopping of quiet generation is disabled by default. To opt in, set `browser.autoRecoverStalls: true` and a `browser.stallRecoveryMs` threshold (default 90000 ms). The harness may then stop a quiet response after a tool and continue the unfinished task only after confirming it stopped. Active tools and pending approvals prevent this recovery. Since long reasoning can look like a stall, keep `autoRecoverStalls: false` for uninterrupted waiting. A legacy `stallRecoveryMs` value alone does not enable automatic stopping.

## External MCP servers, skills, and project instructions

Use `/mcp` to inspect configured MCP servers and `/mcp add` to configure one. Project `AGENTS.md` instructions are loaded from the workspace. Skills can be inspected with `/skills`; place project-specific skill resources in the documented workspace locations.

## Context and compaction

Set a context target with `/context <tokens>`. The harness estimates context use from prompts and responses and can request a handoff summary before the configured threshold. It then opens a fresh chat and carries the summary forward. `/compact` starts this process manually. ChatGPT Web does not expose its exact token count, so this is an estimate.

## Configuration

User configuration: `~/.chatgpt-coder/config.json`. Optional project configuration: `harness.config.json`, generated with `chatgpt-coder --init`. Precedence is defaults → user config → project config → environment variables.

Common environment variables include `TUNNEL_ID`, `CONTROL_PLANE_API_KEY`, `SEARXNG_URL`, `MCP_PORT`, `CHATGPT_MODEL_LABEL`, `CHATGPT_EFFORT_LABEL`, `CHATGPT_CONNECTOR_NAME`, `HARNESS_ATTACH_CONNECTOR`, `HARNESS_APPROVAL`, `HARNESS_HEADLESS`, and `HARNESS_SHELL`. Use `.env.example` as a starting point for source development. Do not commit secrets.

Example project configuration:

```json
{
  "approvalMode": "ask",
  "browser": {
    "headless": false,
    "useTemporaryChat": true,
    "modelLabel": "",
    "connectorName": "chatgpt-coder",
    "attachConnector": true
  },
  "mcp": { "host": "127.0.0.1", "port": 8790, "path": "/mcp" },
  "tunnel": { "enabled": true, "tunnelId": "tunnel_..." },
  "searxng": { "url": "http://127.0.0.1:8888" }
}
```

### SearXNG

`web_search` uses the SearXNG JSON API at `SEARXNG_URL` (default `http://127.0.0.1:8888`). Enable the JSON format in SearXNG settings and verify with `http://127.0.0.1:8888/search?q=test&format=json`. On Windows, the repository also includes `npm run searxng status|start|restart|stop|logs` for its supported WSL/Docker setup.

## Security

- The MCP server listens on `127.0.0.1`; the tunnel makes an outbound connection and requires no inbound port.
- Every MCP call is tied to the active turn; stale calls are rejected after cancellation or completion.
- Telegram uses HTTPS long polling and accepts commands only from the linked user in a private chat.
- The Telegram token is entered in a hidden prompt. Windows protects it with DPAPI; Unix credential files use owner-only permissions.
- File tools stay inside the workspace. Shell commands run with the current account's permissions.
- Approval prompts are enabled by default. `--yolo` and `/approval never` remove this safeguard.
- The browser profile at `~/.chatgpt-coder/browser` contains sensitive account data. Do not share it.
- Tool results are sent to ChatGPT. Do not connect sensitive repositories unless you understand that data flow.

## Current limitations

- ChatGPT DOM selectors can change.
- Context compaction uses an estimate; exact internal ChatGPT Web context is unavailable.
- Web search requires a reachable SearXNG service.
- Tunnel-client, Developer Mode, and the custom MCP connector may need manual setup.
- Connectors are unavailable in unpersonalized temporary chats.

## Development

```powershell
npm run dev
npm run mcp
npm run typecheck
npm test
npm run build
```

Main folders: `src/agent` (orchestrator), `src/browser` (Playwright and selectors), `src/mcp` (MCP server), `src/runtime` (context and diagnostics), `src/tools` (local tools), `src/telegram` (bot), `src/tui` (terminal UI), and `src/tunnel` (tunnel supervisor). Tests are in `tests/`.

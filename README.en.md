# chatgpt-coder

**ChatGPT Web in your terminal. Tools run on your computer.**

A local coding harness for working in your projects: chat with ChatGPT, run commands, edit files, and track tasks in one interface.

[Русская версия](README.md) · [Windows installation](docs/INSTALL-WINDOWS.en.md) · [Command reference](docs/REFERENCE.en.md)

## How it works

You send a task from the terminal. The harness controls ChatGPT Web through a browser. Tool calls travel through an MCP connector and Secure MCP Tunnel to run locally, and results appear in the terminal.

## Features

- Local file access, patches, shell commands, Git tools, and background jobs
- Streaming responses, plans, task goals, and action history
- Separate sessions for each workspace
- Web search through SearXNG and external MCP servers
- Project `AGENTS.md` instructions and skills
- Approval prompts for commands and file writes
- Windows updates with rollback
- A private Telegram bot for remote task control, approvals, and status
- Explicitly started subagents in isolated background browser tabs and project copies

## Quick start

### Install on Windows

Download `chatgpt-coder-windows.zip` from [GitHub Releases](https://github.com/angyedz/chatgpt-web-coder/releases), extract it, and run `install.cmd`. Open a new terminal, go to your project, and start the harness:

```powershell
cd 'C:\path\to\project'
chatgpt-coder
```

The installer provides Node.js, Git, dependencies, Chromium, and tunnel-client. See the [Windows installation guide](docs/INSTALL-WINDOWS.en.md) for details and troubleshooting.

### Connect tools

MCP tools require a ChatGPT account with custom MCP connector access, an OpenAI Secure MCP Tunnel, and a runtime API key with **Tunnels Read + Use** permissions. Sign in to ChatGPT in the browser, then enter the key in the harness:

```text
/connect key <runtime-key>
```

Create a custom MCP connector in ChatGPT for the tunnel. See [Windows setup](docs/INSTALL-WINDOWS.en.md#3-connect-chatgpt-and-tools) and the [reference](docs/REFERENCE.en.md#secure-mcp-tunnel-and-chatgpt-connector).

### Run from source

Requires Node.js 22+ and npm:

```powershell
npm install
npm run setup
npm run dev
```

Use `/connect` to configure the connection. Local settings can be based on `.env.example` and `harness.config.example.json`.

## Commands

| Command | Purpose |
| --- | --- |
| `/help` · `/status` · `/doctor` | Help, status, diagnostics |
| `/connect` · `/mcp` | Tunnel and MCP server configuration |
| `/sessions` · `/session new` | Saved sessions and a new session |
| `/attach` · `/attachments` · `/detach <id>` | Attach and manage local files |
| `/clear` | Clear the view and start with a fresh context |
| `/btw <question>` · `/btw cancel` | Ask a side question or cancel it |
| `/telegram setup` · `/telegram status` | Connect or inspect a private Telegram bot |
| `/telegram start` · `/telegram stop` · `/telegram unlink` | Manage the Telegram connection |
| `/goal <task>` · `/goal status` | Start or inspect an automatically continued goal |
| `/swarm start 5 <task>` | Explicitly start up to five subagents |
| `/swarm status` · `/swarm inspect 1` · `/swarm chat 1` | Inspect subagents and their results |
| `/model` · `/effort` | List ChatGPT models and reasoning effort levels |
| `/timer 5m` · `/jobs` | Timers and background jobs |
| `/skills` · `/agents` | Available skills and project instructions |
| `/update check` · `/update latest` | Check for and download GitHub updates |
| `/update` · `/update rollback` | Install a local ZIP or roll back on Windows |

See the full [command reference](docs/REFERENCE.en.md).

### Subagents

A dedicated background orchestrator chooses assignments from the shared objective and requested worker count. Worker numbers have no fixed roles. The orchestrator reviews progress about every 30 seconds and when a worker finishes, then sends clarifications, revisions, verification or dependent work as needed. Busy workers queue instructions until their current turn ends. The group finishes only after the orchestrator reviews the results; `/swarm status` and saved reports include its state and findings. The orchestrator uses one additional browser tab beyond the requested 1–5 workers.

The orchestrator controls the group only through actual `update_swarm` MCP calls. Assistant text, including JSON, never launches workers. A missing call triggers another review without failing unused workers. Browser errors and waiting for an active group do not automatically block the user goal.

Tabs sharing a browser profile prepare sequentially: chat creation, verified model and effort selection, MCP attachment and submission. Response waits remain parallel. Every nested picker layer is dismissed; covered or replaced controls are reacquired. Setup failures before submission can be retried safely, and existing failed worker IDs can be reassigned.

Workers may stay `idle` while waiting for dependencies or when there is no useful parallel work. The orchestrator records the reason and can assign work to them later.

Subagents only start when explicitly requested. Start up to five with `/swarm start 5 <task>`. Each gets its own background ChatGPT tab and local project copy. Secrets such as `.env` files and private keys are excluded. Changes are copied back only when the target files have not changed in the meantime. Review status and conflicts with `/swarm history` and `/swarm report <run-id>`.

### Telegram bot

Create a bot with [@BotFather](https://t.me/BotFather), then run `/telegram setup` in the harness. Pair it from a private chat using the one-time words. The bot interface is in English. Only the linked Telegram account can control the harness; groups and other accounts are ignored. It supports task submission, session selection, approvals, subagents, model settings, and updates. See the [reference](docs/REFERENCE.en.md#telegram).

### Long messages and attachments

Long prompts are stored locally and attached as files so the full text is preserved. Attach local files with `/attach <path>` or use the Windows clipboard command `/attach clipboard`. Local files are not automatically sent with Telegram messages.

## Long-running responses

Long ChatGPT responses, including silent reasoning, have no overall response time limit. The harness keeps waiting for the same request until it finishes or you cancel with Esc or `/stop`; elapsed time alone does not block a goal. `browser.responseTimeoutMs` is now an inactivity reminder interval. Automatic stopping of apparently stalled responses is disabled by default (`browser.autoRecoverStalls: false`).

## Updates and releases

Use `/update check`, `/update latest`, then `/update apply` to install a verified GitHub release. A local ZIP can be selected with `/update`; rollback is available with `/update rollback`.

Pushes to `main` run Windows CI, type checks, tests, and packaging. A verified successful build is published as a GitHub Release. Change `package.json` and `package-lock.json` when the product version should change.

## Data and access

The harness uses your ChatGPT browser session and runs local tools with your account's permissions. Shell commands and file writes require approval by default. Treat browser profiles, credentials, and project files as sensitive. Tool results are sent to ChatGPT to complete your request.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

## Documentation

- [Windows installation](docs/INSTALL-WINDOWS.en.md) · [Russian](docs/INSTALL-WINDOWS.md)
- [Command and configuration reference](docs/REFERENCE.en.md) · [Russian](docs/REFERENCE.md)
- [GitHub publishing](docs/GITHUB.en.md) · [Russian](docs/GITHUB.md)
- [Pre-release channel](PRE-RELEASE.en.md) · [Russian](PRE-RELEASE.md)

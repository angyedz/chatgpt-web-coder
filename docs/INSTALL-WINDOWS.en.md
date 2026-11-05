# Install chatgpt-coder on Windows

[Русская инструкция](INSTALL-WINDOWS.md) · [English overview](../README.en.md)

## Requirements

- Windows 10 or 11, x64 or ARM64
- Internet access to download runtimes and browser dependencies
- A ChatGPT account for browser use; custom MCP access is needed for local tools

## 1. Install

Open PowerShell in the extracted project folder and run:

```powershell
.\install.cmd
```

The installer downloads its own Node.js runtime, Git, npm dependencies, Chromium, and `tunnel-client`. It compiles the launcher and adds the installation directory to your user PATH. Keep the installer window open until it reports success. If setup fails, read the displayed step and log file before trying again.

The installed program, runtimes, browser, and releases are stored under `%LOCALAPPDATA%\Programs\chatgpt-coder`. User settings and browser sessions are stored separately under `%USERPROFILE%\.chatgpt-coder`.

## 2. Start in a project folder

Open a **new** terminal so it receives the updated PATH, then run:

```powershell
cd 'C:\path\to\your\project'
chatgpt-coder
```

At first launch, sign in to ChatGPT in the opened Chromium window. The harness resumes when the chat composer is available. The current directory becomes the workspace; file tools are confined to it.

## 3. Connect ChatGPT and tools

The browser session is used for ChatGPT. To let ChatGPT invoke local tools, configure an OpenAI Secure MCP Tunnel and custom MCP connector:

1. Create a tunnel in [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels) and copy its `tunnel_...` ID.
2. Create a runtime API key with **Tunnels Read + Use** permissions.
3. In the harness, enter the tunnel ID and key:

   ```text
   /connect tunnel tunnel_...
   /connect key <runtime-key>
   ```

   The tunnel ID and key are user settings. The key is stored in the user credentials file, not in the project.
4. In ChatGPT, enable Developer Mode if required by your account. Add a custom MCP server using **Connection: Tunnel**, choose your tunnel, and install the connector. Follow the current [OpenAI connector guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
5. Name the connector `chatgpt-coder`, or set the name in the harness with `/connect name <name>`.
6. Wait for the harness `tunnel` indicator to turn green. The temporary chat must be **Personalized** for connectors to be available.

Use `/doctor`, `/tunnel`, and `/status` to diagnose connection problems. `chatgpt-coder --doctor` checks the local setup without opening the TUI. If the connector is unavailable, verify that the account and workspace permit custom connectors and that the tunnel is ready.

## Build an update ZIP

From a source checkout with Node.js 22+ and npm installed, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-update.ps1
```

The generated ZIP can be installed with `/update` and `/update apply`.

## Settings and data

- `%LOCALAPPDATA%\Programs\chatgpt-coder` — installed program and runtimes
- `%USERPROFILE%\.chatgpt-coder\config.json` — user connection settings
- `%USERPROFILE%\.chatgpt-coder\credentials.json` — tunnel credentials
- `%USERPROFILE%\.chatgpt-coder\browser` — ChatGPT browser profile; sensitive
- `%USERPROFILE%\.chatgpt-coder\sessions` — saved chats
- `harness.config.json` and `.env` — optional project-specific settings

The project config can override user settings, and environment variables have the highest priority. Set `CHATGPT_CODER_HOME` to use a different user-data folder. Uninstall by removing the installation folder from your user PATH and deleting it in Explorer. User data is separate and remains until you remove it.

## Troubleshooting

- **Download or install failed:** Check access to Node.js, npm, GitHub, and Playwright download servers; then retry. The previous installed version remains available until installation succeeds.
- **The ZIP file picker fails with `ENOENT` and `#< CLIXML`:** On older versions, enter the path directly: `/update "C:\path\to\update.zip"`, then run `/update apply`.
- **The command is not found:** Open a new terminal and check `Get-Command chatgpt-coder -All`.
- **Chromium will not start:** Rerun the installer. The harness uses its installed browser, not system Chrome.
- **Web search is unavailable:** Configure a SearXNG instance with `SEARXNG_URL`; the installer can also start its own container when Docker Desktop is available.
- **The tunnel is not connected:** Check the tunnel ID, key permissions, ChatGPT workspace, temporary-chat mode, and `/tunnel` output.
- **Settings differ between project folders:** Check local `.env`, `harness.config.json`, and environment variables for overrides.

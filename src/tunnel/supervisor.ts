import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { TunnelConfig } from "../config.js";
import type { HarnessEvents } from "../events.js";
import { harnessHome } from "../utils/paths.js";

export class TunnelSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private readonly profilePath: string;
  private readonly logPath: string;

  constructor(
    private readonly config: TunnelConfig,
    private readonly mcpUrl: string,
    private readonly events: HarnessEvents,
  ) {
    const dir = path.join(harnessHome(), "tunnel");
    mkdirSync(dir, { recursive: true });
    this.profilePath = path.join(dir, `${config.profile}.yaml`);
    this.logPath = path.join(dir, `${config.profile}.log`);
  }

  get profileFile(): string {
    return this.profilePath;
  }

  get logFile(): string {
    return this.logPath;
  }

  async start(): Promise<boolean> {
    if (this.child && this.child.exitCode === null) return true;
    if (!this.config.enabled) {
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "off",
        detail: "disabled in config",
      });
      return false;
    }

    if (!this.config.tunnelId) {
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "error",
        detail: "TUNNEL_ID is missing",
      });
      this.events.emit({
        type: "notice",
        level: "warn",
        text: "Tunnel disabled: set TUNNEL_ID and CONTROL_PLANE_API_KEY, then restart.",
      });
      return false;
    }

    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "error",
        detail: `${this.config.apiKeyEnv} is missing`,
      });
      this.events.emit({
        type: "notice",
        level: "warn",
        text: `Tunnel disabled: environment variable ${this.config.apiKeyEnv} is not set.`,
      });
      return false;
    }

    if (!existsSync(this.config.binary)) {
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "error",
        detail: "tunnel-client binary not found",
      });
      this.events.emit({
        type: "notice",
        level: "error",
        text: `tunnel-client not found at ${this.config.binary}. Run "npm run setup:tunnel".`,
      });
      return false;
    }

    writeFileSync(this.profilePath, this.buildProfile(), { encoding: "utf8", mode: 0o600 });
    await secureFile(this.profilePath);

    const log = createWriteStream(this.logPath, { flags: "a" });
    log.write(`\n=== ${new Date().toISOString()} starting tunnel ${this.config.profile} ===\n`);

    const child = spawn(
      this.config.binary,
      ["run", "--profile-file", this.profilePath, ...this.config.extraArgs],
      {
        env: { ...process.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdin.on("error", () => undefined);

    const write = (chunk: Buffer) => {
      log.write(chunk);
    };
    child.stdout.on("data", write);
    child.stderr.on("data", write);

    child.on("error", (error) => {
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "error",
        detail: error.message,
      });
      this.events.emit({
        type: "notice",
        level: "error",
        text: `tunnel-client failed: ${error.message}`,
      });
    });

    child.on("exit", (code) => {
      if (this.stopped) return;
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "error",
        detail: `exited with code ${code ?? "?"}`,
      });
      this.events.emit({
        type: "notice",
        level: "warn",
        text: `tunnel-client exited with code ${code ?? "?"}. See ${this.logPath}`,
      });
    });

    this.events.emit({
      type: "status",
      key: "tunnel",
      state: "starting",
      detail: this.config.profile,
    });

    const ready = await this.waitForReady(30_000);
    if (ready) {
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "up",
        detail: `profile ${this.config.profile}`,
      });
      this.events.emit({
        type: "notice",
        level: "info",
        text: `Tunnel ${this.config.profile} is ready.`,
      });
    } else {
      this.events.emit({
        type: "status",
        key: "tunnel",
        state: "error",
        detail: "not ready; see tunnel log",
      });
      this.events.emit({
        type: "notice",
        level: "warn",
        text: `tunnel-client did not report ready within 30s. See ${this.logPath}`,
      });
    }

    return ready;
  }

  async restart(): Promise<boolean> {
    await this.stop();
    this.stopped = false;
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child || child.killed) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      if (process.platform === "win32" && child.pid !== undefined) {
        // tunnel-client may own a cloudflared child; kill the whole tree so the
        // health port and outbound connection are actually released.
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => {
          child.kill();
        });
        killer.on("close", () => {
          if (child.exitCode === null) child.kill();
        });
      } else {
        child.kill();
      }
    });

    this.child = undefined;
    this.events.emit({ type: "status", key: "tunnel", state: "off" });
  }

  private buildProfile(): string {
    return YAML.stringify({
      config_version: 1,
      control_plane: {
        tunnel_id: this.config.tunnelId,
        api_key: `env:${this.config.apiKeyEnv}`,
      },
      mcp: {
        server_urls: [
          {
            channel: "main",
            url: this.mcpUrl,
          },
        ],
      },
      health: {
        listen_addr: `127.0.0.1:${this.config.healthPort}`,
      },
      admin_ui: {
        open_browser: false,
      },
      log: {
        level: "info",
        format: "struct-text",
      },
    });
  }

  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${this.config.healthPort}/readyz`;
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) return false;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return true;
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }
}

async function secureFile(file: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(file, "r+");
    await handle.chmod(0o600);
    await handle.close();
  } catch {
    /* best effort */
  }
}

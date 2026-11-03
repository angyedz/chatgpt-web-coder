import "dotenv/config";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expandHome, harnessHome } from "./utils/paths.js";

export type ApprovalMode = "ask" | "never";
export type UpdateChannel = "stable" | "pre-release";

export interface BrowserConfig {
  headless: boolean;
  baseUrl: string;
  userDataDir: string;
  channel: string;
  useTemporaryChat: boolean;
  newChatPerTurn: boolean;
  modelLabel: string;
  effortLabel: string;
  connectorName: string;
  attachConnector: boolean;
  autoApproveToolCalls: boolean;
  loginTimeoutMs: number;
  responseTimeoutMs: number;
  stallRecoveryMs: number;
  navigationTimeoutMs: number;
}

export interface McpConfig {
  host: string;
  port: number;
  path: string;
}

export interface ExternalMcpServer {
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface TunnelConfig {
  enabled: boolean;
  tunnelId: string;
  profile: string;
  binary: string;
  apiKeyEnv: string;
  healthPort: number;
  extraArgs: string[];
}

export interface SearxngConfig {
  url: string;
  categories: string;
  language: string;
}

export interface TelegramConfig {
  enabled: boolean;
  ownerUserId: string;
  ownerChatId: string;
  botUsername: string;
  dashboardMessageId: number;
  updateOffset: number;
  selectedSessionId?: string;
}

export interface HarnessConfig {
  workspace: string;
  approvalMode: ApprovalMode;
  maxOutputChars: number;
  context: { maxTokens: number };
  updates: { repository: string; autoCheck: boolean; channel: UpdateChannel };
  browser: BrowserConfig;
  mcp: McpConfig;
  mcpServers: Record<string, ExternalMcpServer>;
  skills: { paths: string[] };
  tunnel: TunnelConfig;
  searxng: SearxngConfig;
  telegram: TelegramConfig;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function defaultConfig(workspace = process.cwd()): HarnessConfig {
  const home = harnessHome();
  return {
    workspace,
    approvalMode: process.env.HARNESS_APPROVAL === "never" ? "never" : "ask",
    maxOutputChars: 30_000,
    context: { maxTokens: 200_000 },
    updates: { repository: process.env.CHATGPT_CODER_UPDATE_REPOSITORY ?? "angyedz/chatgpt-web-coder", autoCheck: true, channel: "stable" },
    browser: {
      headless: process.env.HARNESS_HEADLESS === "true",
      baseUrl: process.env.CHATGPT_URL ?? "https://chatgpt.com/",
      userDataDir: path.join(home, "browser"),
      channel: "",
      useTemporaryChat: true,
      newChatPerTurn: false,
      modelLabel: process.env.CHATGPT_MODEL_LABEL ?? "",
      effortLabel: process.env.CHATGPT_EFFORT_LABEL ?? "",
      connectorName: process.env.CHATGPT_CONNECTOR_NAME ?? "chatgpt-coder",
      attachConnector: process.env.HARNESS_ATTACH_CONNECTOR !== "false",
      autoApproveToolCalls: true,
      loginTimeoutMs: 10 * 60_000,
      responseTimeoutMs: 15 * 60_000,
      stallRecoveryMs: 90_000,
      navigationTimeoutMs: 60_000,
    },
    mcp: {
      host: "127.0.0.1",
      port: Number(process.env.MCP_PORT ?? 8790),
      path: "/mcp",
    },
    mcpServers: {},
    skills: { paths: [] },
    tunnel: {
      enabled: true,
      tunnelId: process.env.TUNNEL_ID ?? "",
      profile: "chatgpt-coder",
      binary:
        process.env.TUNNEL_BINARY ??
        path.join(
          home,
          "bin",
          process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client",
        ),
      apiKeyEnv: "CONTROL_PLANE_API_KEY",
      healthPort: 8791,
      extraArgs: [],
    },
    searxng: {
      url: process.env.SEARXNG_URL ?? "http://127.0.0.1:8888",
      categories: "general",
      language: "auto",
    },
    telegram: { enabled: false, ownerUserId: "", ownerChatId: "", botUsername: "", dashboardMessageId: 0, updateOffset: 0 },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch as T) ?? base;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value)
        ? merge(current, value)
        : value;
  }
  return result as T;
}

export function configPath(workspace: string): string {
  return process.env.HARNESS_CONFIG
    ? path.resolve(expandHome(process.env.HARNESS_CONFIG))
    : path.join(workspace, "harness.config.json");
}

export function globalConfigPath(): string {
  return path.join(harnessHome(), "config.json");
}

function readConfigFile(file: string): DeepPartial<HarnessConfig> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isPlainObject(parsed)) throw new Error("Expected a JSON object.");
    return parsed as DeepPartial<HarnessConfig>;
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadConfig(workspace = process.cwd()): HarnessConfig {
  const base = defaultConfig(workspace);
  const file = configPath(workspace);
  let merged = merge(base, readConfigFile(globalConfigPath()));
  merged = merge(merged, readConfigFile(file));

  merged.workspace = workspace;
  if (merged.updates.channel !== "stable" && merged.updates.channel !== "pre-release") {
    throw new Error("Invalid update channel in configuration. Use stable or pre-release.");
  }
  merged.updates.repository = process.env.CHATGPT_CODER_UPDATE_REPOSITORY ?? merged.updates.repository;
  merged.searxng.url =
    process.env.SEARXNG_URL ?? merged.searxng.url;
  merged.mcp.port = Number(process.env.MCP_PORT ?? merged.mcp.port);
  merged.browser.modelLabel =
    process.env.CHATGPT_MODEL_LABEL ?? merged.browser.modelLabel;
  merged.browser.effortLabel = process.env.CHATGPT_EFFORT_LABEL ?? merged.browser.effortLabel;
  merged.browser.connectorName =
    process.env.CHATGPT_CONNECTOR_NAME ?? merged.browser.connectorName;
  merged.browser.attachConnector =
    process.env.HARNESS_ATTACH_CONNECTOR === undefined
      ? merged.browser.attachConnector
      : process.env.HARNESS_ATTACH_CONNECTOR !== "false";
  merged.browser.headless =
    process.env.HARNESS_HEADLESS === undefined
      ? merged.browser.headless
      : process.env.HARNESS_HEADLESS === "true";
  merged.approvalMode =
    process.env.HARNESS_APPROVAL === "never"
      ? "never"
      : process.env.HARNESS_APPROVAL === "ask"
        ? "ask"
        : merged.approvalMode;
  merged.tunnel.tunnelId = process.env.TUNNEL_ID ?? merged.tunnel.tunnelId;
  merged.tunnel.binary = process.env.TUNNEL_BINARY ?? merged.tunnel.binary;

  const credentialsFile = path.join(harnessHome(), "credentials.json");
  if (!process.env[merged.tunnel.apiKeyEnv] && existsSync(credentialsFile)) {
    try {
      const credentials = JSON.parse(readFileSync(credentialsFile, "utf8")) as Record<string, string>;
      const storedKey = credentials[merged.tunnel.apiKeyEnv];
      if (storedKey) process.env[merged.tunnel.apiKeyEnv] = storedKey;
    } catch {
      // An invalid credential store must not prevent browser-only startup.
    }
  }
  if (!process.env.TELEGRAM_BOT_TOKEN && existsSync(credentialsFile)) {
    try {
      const credentials = JSON.parse(readFileSync(credentialsFile, "utf8")) as Record<string, string>;
      const value = credentials.TELEGRAM_BOT_TOKEN;
      if (value) process.env.TELEGRAM_BOT_TOKEN = decodeCredential(value);
    } catch {
      // Telegram is optional; a locked or damaged credential store must not
      // prevent the local harness from starting.
    }
  }

  merged.browser.userDataDir = path.resolve(expandHome(merged.browser.userDataDir));
  merged.tunnel.binary = path.resolve(expandHome(merged.tunnel.binary));

  return merged;
}

export function saveHarnessConfig(config: HarnessConfig): void {
  const file = configPath(config.workspace);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function saveUpdateSetting(config: HarnessConfig, key: "repository" | "autoCheck" | "channel", value: string | boolean): void {
  const globalFile = globalConfigPath();
  const global = readConfigFile(globalFile) ?? {};
  const settings = (global.updates ?? {}) as Record<string, unknown>;
  settings[key] = value;
  (global as Record<string, unknown>).updates = settings;
  mkdirSync(path.dirname(globalFile), { recursive: true });
  writeFileSync(globalFile, `${JSON.stringify(global, null, 2)}\n`, "utf8");
  const localFile = configPath(config.workspace);
  if (path.resolve(localFile) === path.resolve(globalFile)) return;
  const local = readConfigFile(localFile);
  const localSettings = local?.updates as Record<string, unknown> | undefined;
  if (local && localSettings && Object.hasOwn(localSettings, key)) {
    localSettings[key] = value;
    writeFileSync(localFile, `${JSON.stringify(local, null, 2)}\n`, "utf8");
  }
}

// Connection identity is shared across projects. If this project already has
// an explicit override for the same key, update it as well so the next launch
// does not silently revert the value just chosen by the user.
export function saveConnectionSetting(config: HarnessConfig, section: "tunnel" | "browser", key: "tunnelId" | "connectorName" | "modelLabel" | "effortLabel", value: string): void {
  const globalFile = globalConfigPath();
  const global = readConfigFile(globalFile) ?? {};
  const sectionValue = (global[section] ?? {}) as Record<string, unknown>;
  sectionValue[key] = value;
  (global as Record<string, unknown>)[section] = sectionValue;
  mkdirSync(path.dirname(globalFile), { recursive: true });
  writeFileSync(globalFile, `${JSON.stringify(global, null, 2)}\n`, "utf8");
  const localFile = configPath(config.workspace);
  if (path.resolve(localFile) === path.resolve(globalFile)) return;
  const local = readConfigFile(localFile);
  const localSection = local?.[section] as Record<string, unknown> | undefined;
  if (local && localSection && Object.hasOwn(localSection, key)) {
    localSection[key] = value;
    writeFileSync(localFile, `${JSON.stringify(local, null, 2)}\n`, "utf8");
  }
}

export function saveTunnelApiKey(envName: string, apiKey: string): void {
  const file = path.join(harnessHome(), "credentials.json");
  let credentials: Record<string, string> = {};
  if (existsSync(file)) {
    try {
      credentials = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      credentials = {};
    }
  }
  credentials[envName] = apiKey;
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
  process.env[envName] = apiKey;
}

export function readCredential(name: string): string | undefined {
  const file = path.join(harnessHome(), "credentials.json");
  if (!existsSync(file)) return process.env[name] || undefined;
  const credentials = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const stored = credentials[name];
  return stored ? decodeCredential(stored) : process.env[name] || undefined;
}

export function saveCredential(name: string, value: string): void {
  const file = path.join(harnessHome(), "credentials.json");
  const credentials = readCredentialStore(file);
  credentials[name] = encodeCredential(value);
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
  process.env[name] = value;
}

export function removeCredential(name: string): void {
  const file = path.join(harnessHome(), "credentials.json");
  if (existsSync(file)) {
    const credentials = readCredentialStore(file);
    delete credentials[name];
    writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(file, 0o600);
  }
  delete process.env[name];
}

export function saveTelegramProfile(config: HarnessConfig, patch: Partial<TelegramConfig>): void {
  const next = { ...config.telegram, ...patch };
  const globalFile = globalConfigPath();
  const global = readConfigFile(globalFile) ?? {};
  (global as Record<string, unknown>).telegram = next;
  mkdirSync(path.dirname(globalFile), { recursive: true });
  writeFileSync(globalFile, `${JSON.stringify(global, null, 2)}\n`, "utf8");
  const localFile = configPath(config.workspace);
  if (path.resolve(localFile) !== path.resolve(globalFile)) {
    const local = readConfigFile(localFile);
    if (local?.telegram) {
      (local as Record<string, unknown>).telegram = next;
      writeFileSync(localFile, `${JSON.stringify(local, null, 2)}\n`, "utf8");
    }
  }
  config.telegram = next;
}

function readCredentialStore(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== "string")) throw new Error("invalid credential data");
    return value as Record<string, string>;
  } catch {
    throw new Error(`Cannot safely update credentials: ${file} is unreadable or invalid.`);
  }
}

function encodeCredential(value: string): string {
  if (process.platform !== "win32") return value;
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($value); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: value, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("Windows user encryption is unavailable; Telegram token was not saved.");
  return `dpapi:v1:${result.stdout.trim()}`;
}

function decodeCredential(value: string): string {
  if (!value.startsWith("dpapi:v1:")) return value;
  if (process.platform !== "win32") throw new Error("This credential is protected for a different operating system.");
  const encoded = value.slice("dpapi:v1:".length);
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $encoded=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($encoded); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: encoded, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Could not decrypt the saved Telegram credential for this Windows account.");
  return result.stdout;
}

export function exampleConfig(): string {
  return JSON.stringify(
    {
      approvalMode: "ask",
      context: { maxTokens: 200_000 },
      updates: { repository: "angyedz/chatgpt-web-coder", autoCheck: true, channel: "stable" },
      browser: {
        headless: false,
        useTemporaryChat: true,
        newChatPerTurn: false,
        modelLabel: "",
        effortLabel: "",
        connectorName: "chatgpt-coder",
        attachConnector: true,
        autoApproveToolCalls: true,
        stallRecoveryMs: 90_000,
      },
      mcp: { host: "127.0.0.1", port: 8790, path: "/mcp" },
      mcpServers: {},
      skills: { paths: [] },
      tunnel: {
        enabled: true,
        tunnelId: "tunnel_...",
        profile: "chatgpt-coder",
        healthPort: 8791,
      },
      searxng: {
        url: "http://127.0.0.1:8888",
        categories: "general",
        language: "auto",
      },
    },
    null,
    2,
  );
}

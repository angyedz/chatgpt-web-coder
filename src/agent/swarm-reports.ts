import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { harnessHome } from "../utils/paths.js";
import type { SubagentSnapshot } from "../types.js";

export interface SwarmReport {
  id: string;
  objective: string;
  savedAt: number;
  agents: SubagentSnapshot[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,90}$/;
const MAX_REPORT_BYTES = 1024 * 1024;

function reportDirectory(directory?: string): string {
  return directory ?? path.join(harnessHome(), "swarm-reports");
}

export async function saveSwarmReport(
  report: SwarmReport,
  directory?: string,
): Promise<void> {
  if (!ID.test(report.id)) throw new Error("Invalid swarm report ID.");
  const root = reportDirectory(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, `${report.id}.json`);
  const temporary = path.join(root, `.${report.id}-${randomUUID()}.tmp`);
  const payload = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(payload) > MAX_REPORT_BYTES) throw new Error("Swarm report exceeds 1 MiB.");
  try {
    await writeFile(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readSwarmReport(id: string, directory?: string): Promise<SwarmReport> {
  if (!ID.test(id)) throw new Error("Invalid swarm report ID.");
  const file = path.join(reportDirectory(directory), `${id}.json`);
  const { stat } = await import("node:fs/promises");
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error("Invalid swarm report file.");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid swarm report.");
  const data = parsed as Partial<SwarmReport>;
  if (data.id !== id || typeof data.objective !== "string" || !Array.isArray(data.agents) || typeof data.savedAt !== "number") throw new Error("Invalid swarm report.");
  return data as SwarmReport;
}

export async function listSwarmReports(directory?: string, limit = 10): Promise<SwarmReport[]> {
  const root = reportDirectory(directory);
  let names: string[];
  try { names = (await readdir(root)).filter((name) => name.endsWith(".json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const reports = await Promise.all(names.map(async (name) => {
    try { return await readSwarmReport(name.slice(0, -5), root); }
    catch { return undefined; }
  }));
  return reports.filter((report): report is SwarmReport => Boolean(report))
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, Math.max(0, Math.min(50, limit)));
}

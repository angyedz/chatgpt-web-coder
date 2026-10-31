import { randomUUID } from "node:crypto";

export function newId(prefix = "id"): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

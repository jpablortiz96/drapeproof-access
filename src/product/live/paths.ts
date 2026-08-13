import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function repositoryRoot(): string {
  const configured = process.env.DRAPEPROOF_REPOSITORY_ROOT?.trim();
  if (configured) return resolve(configured);
  const current = resolve(process.cwd());
  if (existsSync(resolve(current, "config/continuity-policy.json"))) return current;
  const parent = resolve(current, "..");
  if (existsSync(resolve(parent, "config/continuity-policy.json"))) return parent;
  throw new Error("DrapeProof repository root could not be resolved.");
}

export function defaultSessionRoot(): string {
  return resolve(process.env.DRAPEPROOF_DATA_DIR?.trim() || resolve(repositoryRoot(), ".data/drapeproof"));
}

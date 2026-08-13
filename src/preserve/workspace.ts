import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PRESERVE_WORKSPACE_PREFIX = "drapeproof-preserve-";

export async function withPreserveWorkspace<T>(operation: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), PRESERVE_WORKSPACE_PREFIX));
  try {
    return await operation(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

export async function cleanupStalePreserveWorkspaces(options: { olderThanMs: number; nowMs?: number } = { olderThanMs: 24 * 60 * 60 * 1000 }): Promise<string[]> {
  const root = tmpdir();
  const now = options.nowMs ?? Date.now();
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PRESERVE_WORKSPACE_PREFIX)) continue;
    const path = join(root, entry.name);
    const details = await stat(path);
    if (now - details.mtimeMs < options.olderThanMs) continue;
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    removed.push(path);
  }
  return removed;
}

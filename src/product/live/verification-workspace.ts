import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export async function withVerificationWorkspace<T>(operation: (workspace: string) => Promise<T>): Promise<T> {
  const base = resolve(tmpdir(), "drapeproof");
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, "verify-"));
  if (!workspace.startsWith(`${base}${sep}`)) throw new Error("Verification workspace escaped the invocation temporary directory.");
  try {
    return await operation(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve("web/.next");
const scanRoots = [resolve(root, "static"), resolve(root, "server/app"), resolve(root, "server/chunks")];
const textExtensions = new Set([".js", ".json", ".html", ".css", ".map", ".txt"]);
const forbidden = [/[A-Za-z]:\\(?:Users|home|drapeproof-access)\\/i, /\/(?:Users|home)\/[A-Za-z0-9._-]+\//, /file:\/\//i];
const findings: string[] = [];

async function walk(directory: string): Promise<void> {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) {
      const value = await readFile(path, "utf8");
      if (forbidden.some((pattern) => pattern.test(value))) findings.push(path.slice(root.length + 1));
    }
  }
}

for (const directory of scanRoots) await walk(directory);
if (findings.length) {
  process.stderr.write(`Local path leakage found in:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else process.stdout.write("PASS: no local absolute paths in production application or browser bundles.\n");

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Buffer, sha256File } from "../src/hash.js";

describe("SHA-256", () => {
  it("hashes a known value", () => {
    expect(sha256Buffer("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes a file without loading it through the evidence layer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-hash-"));
    const path = join(directory, "fixture.txt");
    await writeFile(path, "abc");
    expect(await sha256File(path)).toBe(sha256Buffer("abc"));
  });
});

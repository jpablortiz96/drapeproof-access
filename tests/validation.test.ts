import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureValidationError, validateFixture } from "../src/validation.js";

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("fixture validation", () => {
  it("accepts a documented PNG size and returns metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-valid-"));
    const path = join(directory, "person.png");
    await writeFile(path, pngHeader(768, 1024));
    await expect(validateFixture(path, "person")).resolves.toMatchObject({
      extension: ".png",
      contentType: "image/png",
      width: 768,
      height: 1024,
    });
  });

  it("reports a missing fixture as manual input", async () => {
    await expect(validateFixture("missing-person.png", "person")).rejects.toThrow(/BLOCKED_MANUAL_INPUT.*Missing person/);
  });

  it("rejects undocumented extensions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-ext-"));
    const path = join(directory, "person.webp");
    await writeFile(path, pngHeader(768, 1024));
    await expect(validateFixture(path, "person")).rejects.toBeInstanceOf(FixtureValidationError);
  });

  it("rejects dimensions below the documented minimum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-small-"));
    const path = join(directory, "person.png");
    await writeFile(path, pngHeader(511, 383));
    await expect(validateFixture(path, "person")).rejects.toThrow(/at least 512x384/);
  });

  it("accepts the documented minimum in portrait orientation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-portrait-"));
    const path = join(directory, "person.png");
    await writeFile(path, pngHeader(384, 512));
    await expect(validateFixture(path, "person")).resolves.toMatchObject({ width: 384, height: 512 });
  });

  it("rejects a long side over 4096 pixels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-large-"));
    const path = join(directory, "garment.png");
    await writeFile(path, pngHeader(512, 4097));
    await expect(validateFixture(path, "garment")).rejects.toThrow(/must not exceed 4096/);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { UnverifiableAlignmentError, extractCrop, loadAndAlignImages } from "../src/verification/image.js";
import type { RawImage } from "../src/verification/types.js";

async function png(path: string, width: number, height: number, color: { r: number; g: number; b: number }): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(path);
}

describe("protected-region image normalization and alignment", () => {
  it("uses identity alignment for equal orientation-normalized dimensions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-align-"));
    const original = join(directory, "a.png");
    const generated = join(directory, "b.png");
    await Promise.all([png(original, 20, 30, { r: 10, g: 20, b: 30 }), png(generated, 20, 30, { r: 10, g: 20, b: 30 })]);
    const aligned = await loadAndAlignImages(original, generated);
    expect(aligned.alignment.strategy).toBe("identity");
    expect(aligned.original.data.equals(aligned.generated.data)).toBe(true);
  });

  it("allows only deterministic uniform scaling for matching aspect ratios", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-scale-"));
    const original = join(directory, "a.png");
    const generated = join(directory, "b.png");
    await Promise.all([png(original, 20, 30, { r: 10, g: 20, b: 30 }), png(generated, 40, 60, { r: 10, g: 20, b: 30 })]);
    const aligned = await loadAndAlignImages(original, generated);
    expect(aligned.alignment.strategy).toBe("uniform_scale_lanczos3");
    expect(aligned.generated).toMatchObject({ width: 20, height: 30 });
  });

  it("returns UNVERIFIABLE_ALIGNMENT for aspect-ratio mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-mismatch-"));
    const original = join(directory, "a.png");
    const generated = join(directory, "b.png");
    await Promise.all([png(original, 20, 30, { r: 0, g: 0, b: 0 }), png(generated, 30, 30, { r: 0, g: 0, b: 0 })]);
    await expect(loadAndAlignImages(original, generated)).rejects.toBeInstanceOf(UnverifiableAlignmentError);
  });

  it("extracts a masked crop without leaking pixels outside the region", () => {
    const image: RawImage = { data: Buffer.alloc(4 * 4 * 3, 200), width: 4, height: 4, channels: 3 };
    const mask = Buffer.alloc(16, 1);
    mask[5] = 0;
    const crop = extractCrop(image, { left: 1, top: 1, width: 2, height: 2 }, mask);
    expect([...crop.data.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...crop.data.subarray(3, 6)]).toEqual([200, 200, 200]);
  });
});

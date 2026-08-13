import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { translate } from "../src/verification/controls.js";
import { measureRegion } from "../src/verification/metrics.js";
import type { RawImage } from "../src/verification/types.js";

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): RawImage {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const color = pixel(x, y);
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
    }
  }
  return { data, width, height, channels: 3 };
}

const mask = (width: number, height: number) => Buffer.alloc(width * height, 1);

describe("protected-region deterministic measurements", () => {
  it("returns identity values for identical images", () => {
    const original = image(20, 20, (x) => x < 10 ? [0, 0, 0] : [255, 255, 255]);
    const result = measureRegion(original, original, mask(20, 20), 12, 0.1);
    expect(result.measurements.mean_absolute_difference.normalized).toBe(0);
    expect(result.measurements.changed_pixel_ratio.ratio).toBe(0);
    expect(result.measurements.ssim.value).toBe(1);
    expect(result.measurements.edge_difference.ratio).toBe(0);
  });

  it("detects a controlled brightness change", () => {
    const original = image(12, 12, () => [100, 100, 100]);
    const generated = image(12, 12, () => [120, 120, 120]);
    const result = measureRegion(original, generated, mask(12, 12), 12, 0.1);
    expect(result.measurements.mean_absolute_difference.normalized).toBeCloseTo(20 / 255, 8);
    expect(result.measurements.changed_pixel_ratio.ratio).toBe(1);
    expect(result.measurements.ssim.value).toBeLessThan(1);
  });

  it("detects translation and edge displacement", () => {
    const original = image(30, 20, (x) => x >= 10 && x <= 14 ? [0, 0, 0] : [255, 255, 255]);
    const generated = translate(original, 5, 0);
    const result = measureRegion(original, generated, mask(30, 20), 12, 0.1);
    expect(result.measurements.changed_pixel_ratio.ratio).toBeGreaterThan(0);
    expect(result.measurements.ssim.value).toBeLessThan(0.8);
    expect(result.measurements.edge_difference.ratio).toBeGreaterThan(0);
  });

  it("detects a localized occlusion", () => {
    const original = image(20, 20, () => [240, 240, 240]);
    const generated = { ...original, data: Buffer.from(original.data) };
    for (let y = 7; y < 13; y += 1) for (let x = 7; x < 13; x += 1) generated.data.fill(0, (y * 20 + x) * 3, (y * 20 + x) * 3 + 3);
    const result = measureRegion(original, generated, mask(20, 20), 12, 0.1);
    expect(result.measurements.changed_pixel_ratio.changed_pixels).toBe(36);
    expect(result.measurements.edge_difference.original_edge_pixels).toBe(0);
    expect(result.measurements.edge_difference.generated_edge_pixels).toBeGreaterThan(0);
  });

  it("treats JPEG re-encoding as non-identical but reproducible", async () => {
    const original = image(32, 32, (x, y) => [x * 7, y * 7, (x + y) * 3]);
    const jpeg = await sharp(original.data, { raw: { width: 32, height: 32, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
    const decoded = await sharp(jpeg).toColourspace("srgb").raw().toBuffer();
    const generated: RawImage = { data: decoded, width: 32, height: 32, channels: 3 };
    const first = measureRegion(original, generated, mask(32, 32), 12, 0.1);
    const second = measureRegion(original, generated, mask(32, 32), 12, 0.1);
    expect(first.measurements.mean_absolute_difference.normalized).toBeGreaterThan(0);
    expect(first.measurements.ssim.value).toBeGreaterThan(0.9);
    expect(first.measurements).toEqual(second.measurements);
    expect(first.artifacts.absoluteDifference.equals(second.artifacts.absoluteDifference)).toBe(true);
  });
});

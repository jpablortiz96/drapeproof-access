import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RegionValidationError,
  createRegionMask,
  normalizedPolygonToPixels,
  readRegionDefinition,
  validateRegionDefinition,
} from "../src/verification/regions.js";

const rectangle = {
  id: "chair-frame",
  label: "Chair frame",
  polygon: [
    { x: 0.1, y: 0.2 },
    { x: 0.4, y: 0.2 },
    { x: 0.4, y: 0.8 },
    { x: 0.1, y: 0.8 },
  ],
};

describe("protected-region definition validation", () => {
  it("accepts a normalized non-empty polygon", () => {
    expect(validateRegionDefinition({ schema_version: "1.0", coordinate_space: "normalized", regions: [rectangle] }).regions[0]).toEqual(rectangle);
  });

  it("rejects out-of-bounds coordinates", () => {
    expect(() => validateRegionDefinition({
      schema_version: "1.0",
      coordinate_space: "normalized",
      regions: [{ ...rectangle, polygon: [...rectangle.polygon.slice(0, 3), { x: 1.1, y: 0.8 }] }],
    })).toThrow(RegionValidationError);
  });

  it("rejects fewer than three unique points and empty regions", () => {
    expect(() => validateRegionDefinition({ schema_version: "1.0", coordinate_space: "normalized", regions: [] })).toThrow(/at least one/);
    expect(() => validateRegionDefinition({
      schema_version: "1.0",
      coordinate_space: "normalized",
      regions: [{ ...rectangle, polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }] }],
    })).toThrow(/unique/);
  });

  it("rejects self-intersecting polygons", () => {
    expect(() => validateRegionDefinition({
      schema_version: "1.0",
      coordinate_space: "normalized",
      regions: [{ ...rectangle, polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }] }],
    })).toThrow(/self-intersect|area/);
  });

  it("reports malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drapeproof-regions-"));
    const path = join(directory, "bad.json");
    await writeFile(path, "{not-json");
    await expect(readRegionDefinition(path)).rejects.toThrow(/Malformed region JSON/);
  });

  it("converts normalized points and rasterizes a deterministic mask", () => {
    expect(normalizedPolygonToPixels([{ x: 0, y: 0 }, { x: 1, y: 1 }], 11, 21)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 20 }]);
    const mask1 = createRegionMask(rectangle, 20, 10);
    const mask2 = createRegionMask(rectangle, 20, 10);
    expect(mask1.equals(mask2)).toBe(true);
    expect([...mask1].filter(Boolean).length).toBeGreaterThan(0);
    expect(mask1.length).toBe(200);
  });
});

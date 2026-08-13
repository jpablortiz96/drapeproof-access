import { readFile } from "node:fs/promises";
import type {
  NormalizedPoint,
  PixelBounds,
  PixelPoint,
  ProtectedRegion,
  RegionDefinitionFile,
} from "./types.js";

export class RegionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function polygonArea(points: readonly NormalizedPoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

function orientation(a: NormalizedPoint, b: NormalizedPoint, c: NormalizedPoint): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function segmentsIntersect(a: NormalizedPoint, b: NormalizedPoint, c: NormalizedPoint, d: NormalizedPoint): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function validatePolygon(points: readonly NormalizedPoint[], id: string): void {
  if (points.length < 3) throw new RegionValidationError(`Region ${id} polygon must contain at least three points.`);
  const unique = new Set(points.map((point) => `${point.x},${point.y}`));
  if (unique.size < 3) throw new RegionValidationError(`Region ${id} polygon must contain at least three unique points.`);
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      throw new RegionValidationError(`Region ${id} polygon coordinates must be finite values from 0 through 1.`);
    }
  }
  if (polygonArea(points) <= 1e-8) throw new RegionValidationError(`Region ${id} polygon area must be non-zero.`);
  for (let left = 0; left < points.length; left += 1) {
    const leftNext = (left + 1) % points.length;
    for (let right = left + 1; right < points.length; right += 1) {
      const rightNext = (right + 1) % points.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (left === 0 && rightNext === 0) continue;
      if (segmentsIntersect(points[left]!, points[leftNext]!, points[right]!, points[rightNext]!)) {
        throw new RegionValidationError(`Region ${id} polygon must not self-intersect.`);
      }
    }
  }
}

export function validateRegionDefinition(value: unknown): RegionDefinitionFile {
  if (!isRecord(value)) throw new RegionValidationError("Region definition must be a JSON object.");
  if (value.schema_version !== "1.0") throw new RegionValidationError("schema_version must be \"1.0\".");
  if (value.coordinate_space !== "normalized") throw new RegionValidationError("coordinate_space must be \"normalized\".");
  if (!Array.isArray(value.regions) || value.regions.length === 0) {
    throw new RegionValidationError("regions must contain at least one protected region.");
  }
  const seen = new Set<string>();
  const regions: ProtectedRegion[] = value.regions.map((item, index) => {
    if (!isRecord(item)) throw new RegionValidationError(`Region at index ${index} must be an object.`);
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) {
      throw new RegionValidationError(`Region at index ${index} has an invalid id.`);
    }
    if (seen.has(item.id)) throw new RegionValidationError(`Duplicate region id: ${item.id}.`);
    seen.add(item.id);
    if (typeof item.label !== "string" || item.label.trim() === "") {
      throw new RegionValidationError(`Region ${item.id} must have a non-empty label.`);
    }
    if (!Array.isArray(item.polygon)) throw new RegionValidationError(`Region ${item.id} polygon must be an array.`);
    const polygon: NormalizedPoint[] = item.polygon.map((point, pointIndex) => {
      if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
        throw new RegionValidationError(`Region ${item.id} point ${pointIndex} must contain numeric x and y.`);
      }
      return { x: point.x, y: point.y };
    });
    validatePolygon(polygon, item.id);
    return { id: item.id, label: item.label.trim(), polygon };
  });
  const output: RegionDefinitionFile = {
    schema_version: "1.0",
    coordinate_space: "normalized",
    regions,
  };
  if (typeof value.source_run_id === "string" && value.source_run_id.trim()) output.source_run_id = value.source_run_id.trim();
  return output;
}

export async function readRegionDefinition(path: string): Promise<RegionDefinitionFile> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new RegionValidationError(`Malformed region JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRegionDefinition(value);
}

export function normalizedPolygonToPixels(
  polygon: readonly NormalizedPoint[],
  width: number,
  height: number,
): PixelPoint[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RegionValidationError("Image dimensions must be positive integers.");
  }
  return polygon.map((point) => ({
    x: Math.min(width - 1, Math.max(0, Math.round(point.x * (width - 1)))),
    y: Math.min(height - 1, Math.max(0, Math.round(point.y * (height - 1)))),
  }));
}

export function polygonBounds(polygon: readonly NormalizedPoint[], width: number, height: number): PixelBounds {
  const minX = Math.min(...polygon.map((point) => point.x));
  const maxX = Math.max(...polygon.map((point) => point.x));
  const minY = Math.min(...polygon.map((point) => point.y));
  const maxY = Math.max(...polygon.map((point) => point.y));
  const left = Math.max(0, Math.min(width - 1, Math.floor(minX * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(minY * height)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(maxX * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(maxY * height)));
  return { left, top, width: right - left, height: bottom - top };
}

function pointOnSegment(x: number, y: number, a: NormalizedPoint, b: NormalizedPoint): boolean {
  const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
  if (Math.abs(cross) > 1e-12) return false;
  return x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) && y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y);
}

export function pointInPolygon(x: number, y: number, polygon: readonly NormalizedPoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    if (pointOnSegment(x, y, a, b)) return true;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function createRegionMask(region: ProtectedRegion, width: number, height: number): Buffer {
  const mask = Buffer.alloc(width * height);
  const bounds = polygonBounds(region.polygon, width, height);
  for (let y = bounds.top; y < bounds.top + bounds.height; y += 1) {
    for (let x = bounds.left; x < bounds.left + bounds.width; x += 1) {
      const normalizedX = (x + 0.5) / width;
      const normalizedY = (y + 0.5) / height;
      if (pointInPolygon(normalizedX, normalizedY, region.polygon)) mask[y * width + x] = 1;
    }
  }
  if (!mask.includes(1)) throw new RegionValidationError(`Region ${region.id} does not cover any image pixels.`);
  return mask;
}

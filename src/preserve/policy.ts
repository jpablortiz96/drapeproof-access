import { readFile } from "node:fs/promises";
import type { PreservePolicy } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, label: string, minimum = 0, maximum = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid preserve policy field: ${label}.`);
  return value;
}

export function validatePreservePolicy(value: unknown): PreservePolicy {
  if (!record(value) || value.name !== "EXPERIMENTAL_PRESERVE_POLICY_V1" || value.version !== "1.0.0" || value.validated !== false || value.repair_implementation !== "PRESERVE_ENGINE_V1") {
    throw new Error("Invalid preserve policy identity.");
  }
  if (!record(value.mapping) || !record(value.context) || !record(value.transformation_zone) || !record(value.outer_ring) || !record(value.material_improvement)) {
    throw new Error("Preserve policy sections are required.");
  }
  finite(value.mapping.minimum_affine_supporting_inliers, "mapping.minimum_affine_supporting_inliers", 1);
  finite(value.mapping.minimum_affine_inlier_ratio, "mapping.minimum_affine_inlier_ratio", 0, 1);
  finite(value.mapping.maximum_affine_scale_change, "mapping.maximum_affine_scale_change", 0, 1);
  finite(value.mapping.maximum_affine_shear, "mapping.maximum_affine_shear", 0, 1);
  for (const key of ["blend_band_pixels", "photometric_context_ring_pixels", "outer_safety_ring_pixels", "minimum_context_pixels"] as const) {
    const item = finite(value.context[key], `context.${key}`, 1);
    if (!Number.isInteger(item)) throw new Error(`Preserve policy field context.${key} must be an integer.`);
  }
  finite(value.context.maximum_context_mean_channel_delta_8bit, "context.maximum_context_mean_channel_delta_8bit", 0, 255);
  finite(value.context.maximum_blend_band_channel_adjustment_8bit, "context.maximum_blend_band_channel_adjustment_8bit", 0, 255);
  finite(value.transformation_zone.per_pixel_max_channel_difference_8bit, "transformation_zone.per_pixel_max_channel_difference_8bit", 0, 255);
  finite(value.transformation_zone.block_at_or_above_overlap_ratio, "transformation_zone.block_at_or_above_overlap_ratio", 0, 1);
  finite(value.transformation_zone.control_window_width_ratio, "transformation_zone.control_window_width_ratio", 0.01, 1);
  finite(value.transformation_zone.control_window_height_ratio, "transformation_zone.control_window_height_ratio", 0.01, 1);
  const step = finite(value.transformation_zone.control_search_step_pixels, "transformation_zone.control_search_step_pixels", 1);
  if (!Number.isInteger(step)) throw new Error("Transformation control search step must be an integer.");
  finite(value.outer_ring.maximum_mean_absolute_difference, "outer_ring.maximum_mean_absolute_difference", 0, 1);
  finite(value.outer_ring.maximum_changed_pixel_ratio, "outer_ring.maximum_changed_pixel_ratio", 0, 1);
  finite(value.outer_ring.minimum_ssim, "outer_ring.minimum_ssim", -1, 1);
  finite(value.outer_ring.maximum_edge_difference, "outer_ring.maximum_edge_difference", 0, 1);
  for (const [key, item] of Object.entries(value.material_improvement)) finite(item, `material_improvement.${key}`, 0, 1);
  return value as unknown as PreservePolicy;
}

export async function readPreservePolicy(path: string): Promise<PreservePolicy> {
  return validatePreservePolicy(JSON.parse(await readFile(path, "utf8")) as unknown);
}

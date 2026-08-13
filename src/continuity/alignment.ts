import type { NormalizedPoint } from "../verification/types.js";

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface AlignmentAssessment {
  status: "VERIFIABLE_UNIFORM_ALIGNMENT" | "UNVERIFIABLE_REGION_ALIGNMENT";
  source_dimensions: ImageDimensions;
  generated_dimensions: ImageDimensions;
  source_aspect_ratio: number;
  generated_aspect_ratio: number;
  relative_aspect_ratio_difference: number;
  scale_x_to_source: number;
  scale_y_to_source: number;
  relative_nonuniform_scale_difference: number;
  alignment_tolerance: number;
  mapping: "same_normalized_polygons" | null;
  reason: string;
}

export function assessRegionAlignment(
  source: ImageDimensions,
  generated: ImageDimensions,
  tolerance = 0.001,
): AlignmentAssessment {
  if (![source.width, source.height, generated.width, generated.height].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Alignment dimensions must be positive integers.");
  }
  const sourceRatio = source.width / source.height;
  const generatedRatio = generated.width / generated.height;
  const ratioDifference = Math.abs(sourceRatio - generatedRatio) / sourceRatio;
  const scaleX = source.width / generated.width;
  const scaleY = source.height / generated.height;
  const scaleDifference = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);
  const verifiable = ratioDifference <= tolerance && scaleDifference <= tolerance;
  return {
    status: verifiable ? "VERIFIABLE_UNIFORM_ALIGNMENT" : "UNVERIFIABLE_REGION_ALIGNMENT",
    source_dimensions: source,
    generated_dimensions: generated,
    source_aspect_ratio: sourceRatio,
    generated_aspect_ratio: generatedRatio,
    relative_aspect_ratio_difference: ratioDifference,
    scale_x_to_source: scaleX,
    scale_y_to_source: scaleY,
    relative_nonuniform_scale_difference: scaleDifference,
    alignment_tolerance: tolerance,
    mapping: verifiable ? "same_normalized_polygons" : null,
    reason: verifiable
      ? "Dimensions permit the locked uniform same-aspect alignment strategy."
      : "Dimensions require non-uniform scaling or undocumented crop/pad geometry; protected polygons cannot be mapped reliably.",
  };
}

export function assertNegativeControlAlignment(assessment: AlignmentAssessment): void {
  if (assessment.status !== "VERIFIABLE_UNIFORM_ALIGNMENT") {
    throw new Error("UNVERIFIABLE_REGION_ALIGNMENT: a joystick mutation cannot be localized on the Bag result without a valid mapping.");
  }
}

export function mapNormalizedPolygonForDisplay(
  polygon: readonly NormalizedPoint[],
  placement: { left: number; top: number; width: number; height: number },
): Array<{ x: number; y: number }> {
  return polygon.map((point) => ({ x: placement.left + point.x * placement.width, y: placement.top + point.y * placement.height }));
}

import { assessRegionAlignment } from "./alignment.js";

export type SignalStatus = "PASS" | "REVIEW" | "FAIL";

export interface FrameSignal {
  status: "PASS" | "FAIL";
  reason_codes: Array<"ASPECT_RATIO_SHIFT" | "NONUNIFORM_SCALE_REQUIRED">;
  source_dimensions: { width: number; height: number };
  generated_dimensions: { width: number; height: number };
  source_aspect_ratio: number;
  generated_aspect_ratio: number;
  relative_aspect_ratio_difference: number;
  source_orientation: "portrait" | "landscape" | "square";
  generated_orientation: "portrait" | "landscape" | "square";
  uniform_scale_compatible: boolean;
  scale_x_to_source: number;
  scale_y_to_source: number;
  relative_nonuniform_scale_difference: number;
  alignment_tolerance: number;
}

function orientation(dimensions: { width: number; height: number }): "portrait" | "landscape" | "square" {
  return dimensions.width === dimensions.height ? "square" : dimensions.width < dimensions.height ? "portrait" : "landscape";
}

export function evaluateFrameGeometry(
  source: { width: number; height: number },
  generated: { width: number; height: number },
  tolerance = 0.001,
): FrameSignal {
  const alignment = assessRegionAlignment(source, generated, tolerance);
  const reasonCodes: FrameSignal["reason_codes"] = [];
  if (alignment.relative_aspect_ratio_difference > tolerance) reasonCodes.push("ASPECT_RATIO_SHIFT");
  if (alignment.relative_nonuniform_scale_difference > tolerance) reasonCodes.push("NONUNIFORM_SCALE_REQUIRED");
  return {
    status: alignment.status === "VERIFIABLE_UNIFORM_ALIGNMENT" ? "PASS" : "FAIL",
    reason_codes: reasonCodes,
    source_dimensions: source,
    generated_dimensions: generated,
    source_aspect_ratio: alignment.source_aspect_ratio,
    generated_aspect_ratio: alignment.generated_aspect_ratio,
    relative_aspect_ratio_difference: alignment.relative_aspect_ratio_difference,
    source_orientation: orientation(source),
    generated_orientation: orientation(generated),
    uniform_scale_compatible: alignment.status === "VERIFIABLE_UNIFORM_ALIGNMENT",
    scale_x_to_source: alignment.scale_x_to_source,
    scale_y_to_source: alignment.scale_y_to_source,
    relative_nonuniform_scale_difference: alignment.relative_nonuniform_scale_difference,
    alignment_tolerance: tolerance,
  };
}

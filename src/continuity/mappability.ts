import type { ProtectedRegion } from "../verification/types.js";
import type { FeatureEvaluation, RawFeatureMatches } from "./features.js";
import type { FrameSignal, SignalStatus } from "./frame.js";

export interface MappedRegion {
  region_id: string;
  label: string;
  status: "MAPPABLE" | "UNMAPPABLE";
  reason_codes: string[];
  mapping_model: "UNIFORM_NORMALIZED_COORDINATES" | null;
  source_polygon_normalized: ProtectedRegion["polygon"];
  generated_polygon_normalized: ProtectedRegion["polygon"] | null;
  generated_polygon_pixels: Array<{ x: number; y: number }> | null;
}

export interface RegionMappability {
  status: Exclude<SignalStatus, "REVIEW">;
  reason_codes: string[];
  mapping_prerequisites: {
    uniform_frame_compatibility: boolean;
    stable_feature_transform: boolean;
    feature_homography_role: "SUPPORTING_GEOMETRIC_EVIDENCE_NOT_USED_TO_OVERRIDE_MAPPING";
  };
  regions: MappedRegion[];
}

export function evaluateRegionMappability(options: {
  regions: readonly ProtectedRegion[];
  frame: FrameSignal;
  featureMatches: RawFeatureMatches;
  featureEvaluation: FeatureEvaluation;
  generatedDimensions: { width: number; height: number };
}): RegionMappability {
  const mappable = options.frame.uniform_scale_compatible && options.featureEvaluation.stable_geometric_transform;
  const reasons = [
    ...options.frame.reason_codes,
    ...(options.featureEvaluation.stable_geometric_transform ? [] : options.featureEvaluation.reason_codes),
  ];
  const uniqueReasons = [...new Set(reasons.length ? reasons : mappable ? [] : ["NO_STABLE_TRANSFORM"] )];
  return {
    status: mappable ? "PASS" : "FAIL",
    reason_codes: uniqueReasons,
    mapping_prerequisites: {
      uniform_frame_compatibility: options.frame.uniform_scale_compatible,
      stable_feature_transform: options.featureEvaluation.stable_geometric_transform,
      feature_homography_role: "SUPPORTING_GEOMETRIC_EVIDENCE_NOT_USED_TO_OVERRIDE_MAPPING",
    },
    regions: options.regions.map((region) => ({
      region_id: region.id,
      label: region.label,
      status: mappable ? "MAPPABLE" : "UNMAPPABLE",
      reason_codes: mappable ? [] : uniqueReasons,
      mapping_model: mappable ? "UNIFORM_NORMALIZED_COORDINATES" : null,
      source_polygon_normalized: region.polygon,
      generated_polygon_normalized: mappable ? region.polygon : null,
      generated_polygon_pixels: mappable ? region.polygon.map((point) => ({
        x: point.x * (options.generatedDimensions.width - 1),
        y: point.y * (options.generatedDimensions.height - 1),
      })) : null,
    })),
  };
}

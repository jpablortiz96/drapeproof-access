import type { NormalizedPoint, PolicyDecision, ProtectedRegion, RawImage, RegionMeasurements } from "../verification/types.js";
import type { SessionContinuityResult } from "../product/live/types.js";

export const PRESERVE_ENGINE_VERSION = "PRESERVE_ENGINE_V1" as const;

export type RepairOutcome =
  | "RESTORED"
  | "IMPROVED_BUT_REVIEW"
  | "UNCHANGED"
  | "REPAIR_FAILED"
  | "REPAIR_BLOCKED_ALIGNMENT"
  | "REPAIR_BLOCKED_CONTINUITY"
  | "REPAIR_BLOCKED_TRANSFORM_OVERLAP"
  | "REPAIR_BLOCKED_INSUFFICIENT_CONTEXT"
  | "NOT_NEEDED";

export interface PreservePolicy {
  name: "EXPERIMENTAL_PRESERVE_POLICY_V1";
  version: "1.0.0";
  validated: false;
  description: string;
  repair_implementation: typeof PRESERVE_ENGINE_VERSION;
  mapping: {
    minimum_affine_supporting_inliers: number;
    minimum_affine_inlier_ratio: number;
    maximum_affine_scale_change: number;
    maximum_affine_shear: number;
  };
  context: {
    blend_band_pixels: number;
    photometric_context_ring_pixels: number;
    outer_safety_ring_pixels: number;
    minimum_context_pixels: number;
    maximum_context_mean_channel_delta_8bit: number;
    maximum_blend_band_channel_adjustment_8bit: number;
  };
  transformation_zone: {
    per_pixel_max_channel_difference_8bit: number;
    block_at_or_above_overlap_ratio: number;
    control_window_width_ratio: number;
    control_window_height_ratio: number;
    control_search_step_pixels: number;
  };
  outer_ring: {
    maximum_mean_absolute_difference: number;
    maximum_changed_pixel_ratio: number;
    minimum_ssim: number;
    maximum_edge_difference: number;
  };
  material_improvement: {
    minimum_mad_reduction: number;
    minimum_changed_ratio_reduction: number;
    minimum_ssim_increase: number;
    minimum_edge_difference_reduction: number;
    maximum_allowed_mad_regression: number;
    maximum_allowed_changed_ratio_regression: number;
    maximum_allowed_ssim_regression: number;
    maximum_allowed_edge_difference_regression: number;
  };
}

export interface VerificationSnapshot {
  decision: PolicyDecision;
  measurements: RegionMeasurements;
}

export interface VerificationDeltas {
  mad_delta: number;
  changed_ratio_delta: number;
  ssim_delta: number;
  edge_difference_delta: number;
}

export interface MappingEvidence {
  model: "identity" | "uniform_scale_translation" | "affine";
  source_to_target_normalized: [number, number, number, number, number, number];
  supporting_inliers: number;
  inlier_ratio: number;
  stable: boolean;
}

export interface RepairEligibility {
  eligible: boolean;
  checks: {
    continuity: "PASS" | "BLOCKED";
    mapping: "PASS" | "BLOCKED";
    bounds: "PASS" | "BLOCKED";
    context: "PASS" | "BLOCKED";
    transformation_overlap: "PASS" | "BLOCKED";
  };
  overlap_pixels: number;
  region_pixels: number;
  overlap_ratio: number;
  overlap_threshold: number;
  context_pixels: number;
  raw_context_mean_channel_delta_8bit: [number, number, number];
  outcome_if_blocked: RepairOutcome | null;
}

export interface MappingTrace {
  model: MappingEvidence["model"];
  source_to_target_normalized: MappingEvidence["source_to_target_normalized"];
  supporting_inliers: number;
  inlier_ratio: number;
  source_polygon: NormalizedPoint[];
  target_polygon: NormalizedPoint[];
}

export interface OuterRingResult {
  measurements: RegionMeasurements;
  passed: boolean;
}

export interface FullImageChangeAccounting {
  modified_pixels: number;
  total_pixels: number;
  modified_pixel_percentage: number;
}

export interface PreservationTrace {
  schema_version: "1.0";
  repair_id: string;
  session_id: string;
  repair_implementation: typeof PRESERVE_ENGINE_VERSION;
  source_hash: string;
  provider_result_hash: string;
  provider_result_immutable: true;
  generated_input_hash: string;
  generated_input_provenance: "REAL_PROVIDER_RESULT" | "SYNTHETIC_CONTROL_MUTATION";
  region_id: string;
  initial_verification: VerificationSnapshot;
  eligibility: RepairEligibility;
  mapping: MappingTrace;
  repair_method: "DETERMINISTIC_SOURCE_RESTORE_DISTANCE_FEATHER";
  repair_parameters: {
    protected_core_source_weight: 1;
    blend_band_pixels: number;
    photometric_context_ring_pixels: number;
    core_photometric_adjustment_8bit: [0, 0, 0];
    blend_band_photometric_adjustment_8bit: [number, number, number];
  };
  output_hash: string;
  final_verification: VerificationSnapshot;
  verification_deltas: VerificationDeltas;
  outer_ring_verification: OuterRingResult;
  full_image_change_accounting: FullImageChangeAccounting;
  outcome: RepairOutcome;
  provider_calls: 0;
  youcam_units: 0;
}

export interface PreserveAttemptInput {
  sessionId: string;
  sourceHash: string;
  providerResultHash: string;
  generatedInputHash: string;
  generatedInputProvenance: "REAL_PROVIDER_RESULT" | "SYNTHETIC_CONTROL_MUTATION";
  source: RawImage;
  /** Immutable provider image used only to estimate the intended transformation zone. */
  transformationReference: RawImage;
  /** Real provider image or explicitly synthetic control derivative being repaired. */
  providerResult: RawImage;
  region: ProtectedRegion;
  continuity: SessionContinuityResult;
  mapping: MappingEvidence;
  initialVerification: VerificationSnapshot;
  policy: PreservePolicy;
}

export interface PreserveAttempt {
  input: PreserveAttemptInput;
  repairId: string;
  sourceHash: string;
  providerResultHash: string;
  mapping: MappingTrace;
  eligibility: RepairEligibility;
  repaired: RawImage;
  mappedSource: RawImage;
  coreMask: Buffer;
  blendMask: Buffer;
  outerRingMask: Buffer;
  transformationZoneMask: Buffer;
  blendAdjustment: [number, number, number];
  changeAccounting: FullImageChangeAccounting;
  provisionalOutcome: RepairOutcome | null;
}

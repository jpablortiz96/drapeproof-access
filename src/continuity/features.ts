import type { SignalStatus } from "./frame.js";

export interface FeaturePolicy {
  minimum_retained_matches_review: number;
  minimum_retained_matches_pass: number;
  minimum_geometric_inliers_review: number;
  minimum_geometric_inliers_pass: number;
  minimum_inlier_ratio_review: number;
  minimum_inlier_ratio_pass: number;
  maximum_median_reprojection_error_pixels_pass: number;
  maximum_median_reprojection_error_pixels_review: number;
}

export interface RawFeatureMatches {
  schema_version: "1.0";
  implementation: string;
  dependency_version: string;
  deterministic_runtime: Record<string, unknown>;
  configuration: Record<string, unknown>;
  source: Record<string, unknown>;
  generated: Record<string, unknown>;
  source_keypoints: number;
  generated_keypoints: number;
  raw_matches: number;
  two_neighbor_match_pairs: number;
  retained_matches: number;
  geometric_inliers: number;
  inlier_ratio: number;
  geometric_transform_estimated: boolean;
  homography_source_pixels_to_generated_pixels: number[][] | null;
  homography_source_normalized_to_generated_normalized: number[][] | null;
  inlier_reprojection_error_working_pixels: { mean: number | null; median: number | null; maximum: number | null };
}

export interface FeatureEvaluation {
  status: SignalStatus;
  reason_codes: Array<"INSUFFICIENT_FEATURE_MATCHES" | "LOW_GEOMETRIC_INLIER_RATIO" | "NO_STABLE_TRANSFORM">;
  stable_geometric_transform: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid feature field: ${label}.`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNumber(value, label);
}

function matrix(value: unknown): number[][] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 3 || value.some((row) => !Array.isArray(row) || row.length !== 3)) {
    throw new Error("Malformed feature homography.");
  }
  return value.map((row, rowIndex) => (row as unknown[]).map((item, columnIndex) => finiteNumber(item, `homography[${rowIndex}][${columnIndex}]`)));
}

export function parseFeatureMatches(value: unknown): RawFeatureMatches {
  if (!isRecord(value) || value.schema_version !== "1.0" || !isRecord(value.inlier_reprojection_error_working_pixels)) {
    throw new Error("Malformed feature worker output.");
  }
  const errors = value.inlier_reprojection_error_working_pixels;
  return {
    schema_version: "1.0",
    implementation: String(value.implementation),
    dependency_version: String(value.dependency_version),
    deterministic_runtime: isRecord(value.deterministic_runtime) ? value.deterministic_runtime : {},
    configuration: isRecord(value.configuration) ? value.configuration : {},
    source: isRecord(value.source) ? value.source : {},
    generated: isRecord(value.generated) ? value.generated : {},
    source_keypoints: finiteNumber(value.source_keypoints, "source_keypoints"),
    generated_keypoints: finiteNumber(value.generated_keypoints, "generated_keypoints"),
    raw_matches: finiteNumber(value.raw_matches, "raw_matches"),
    two_neighbor_match_pairs: finiteNumber(value.two_neighbor_match_pairs, "two_neighbor_match_pairs"),
    retained_matches: finiteNumber(value.retained_matches, "retained_matches"),
    geometric_inliers: finiteNumber(value.geometric_inliers, "geometric_inliers"),
    inlier_ratio: finiteNumber(value.inlier_ratio, "inlier_ratio"),
    geometric_transform_estimated: value.geometric_transform_estimated === true,
    homography_source_pixels_to_generated_pixels: matrix(value.homography_source_pixels_to_generated_pixels),
    homography_source_normalized_to_generated_normalized: matrix(value.homography_source_normalized_to_generated_normalized),
    inlier_reprojection_error_working_pixels: {
      mean: nullableNumber(errors.mean, "reprojection.mean"),
      median: nullableNumber(errors.median, "reprojection.median"),
      maximum: nullableNumber(errors.maximum, "reprojection.maximum"),
    },
  };
}

export function evaluateFeatureMatches(matches: RawFeatureMatches, policy: FeaturePolicy): FeatureEvaluation {
  const median = matches.inlier_reprojection_error_working_pixels.median;
  const noTransform = !matches.geometric_transform_estimated || !matches.homography_source_normalized_to_generated_normalized || median === null;
  const insufficientFail = matches.retained_matches < policy.minimum_retained_matches_review
    || matches.geometric_inliers < policy.minimum_geometric_inliers_review;
  const lowRatioFail = matches.inlier_ratio < policy.minimum_inlier_ratio_review
    || (median !== null && median > policy.maximum_median_reprojection_error_pixels_review);
  const insufficientReview = matches.retained_matches < policy.minimum_retained_matches_pass
    || matches.geometric_inliers < policy.minimum_geometric_inliers_pass;
  const lowRatioReview = matches.inlier_ratio < policy.minimum_inlier_ratio_pass
    || (median !== null && median > policy.maximum_median_reprojection_error_pixels_pass);
  const reasons: FeatureEvaluation["reason_codes"] = [];
  if (insufficientFail || insufficientReview) reasons.push("INSUFFICIENT_FEATURE_MATCHES");
  if (lowRatioFail || lowRatioReview) reasons.push("LOW_GEOMETRIC_INLIER_RATIO");
  if (noTransform) reasons.push("NO_STABLE_TRANSFORM");
  const status: SignalStatus = noTransform || insufficientFail || lowRatioFail ? "FAIL" : insufficientReview || lowRatioReview ? "REVIEW" : "PASS";
  return { status, reason_codes: reasons, stable_geometric_transform: status !== "FAIL" };
}

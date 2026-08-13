import { readFile } from "node:fs/promises";
import type { FeatureEvaluation, FeaturePolicy } from "./features.js";
import type { FrameSignal } from "./frame.js";
import type { RegionMappability } from "./mappability.js";
import type { PoseComparison, PosePolicy } from "./pose.js";

export interface ContinuityPolicy {
  name: "EXPERIMENTAL_CONTINUITY_POLICY_V1";
  version: "1.0.0";
  validated: false;
  purpose: string;
  frame_geometry: { uniform_alignment_tolerance: number };
  pose_geometry: PosePolicy;
  feature_correspondence: FeaturePolicy;
  decision_logic: {
    continuity_fail_on_any_signal_fail: true;
    continuity_review_on_any_signal_review: true;
    local_verification_eligible_only_on_continuity_pass: true;
    region_mapping_requires_uniform_frame_compatibility: true;
    region_mapping_requires_stable_feature_transform: true;
  };
}

export interface ContinuityDecision {
  gate: "CONTINUITY_PASS" | "CONTINUITY_REVIEW" | "CONTINUITY_FAIL";
  reason_codes: string[];
  local_verification_eligibility: "ELIGIBLE" | "BLOCKED";
  local_verification_state: "LOCAL_VERIFICATION_ELIGIBLE" | "LOCAL_VERIFICATION_BLOCKED";
  interpretation: "Geometric eligibility only; not image quality, identity, accessibility, safety, or provider performance.";
}

export async function readContinuityPolicy(path: string): Promise<ContinuityPolicy> {
  const policy = JSON.parse(await readFile(path, "utf8")) as ContinuityPolicy;
  if (policy.name !== "EXPERIMENTAL_CONTINUITY_POLICY_V1" || policy.version !== "1.0.0" || policy.validated !== false) {
    throw new Error("Invalid continuity policy identity or validation state.");
  }
  if (policy.frame_geometry.uniform_alignment_tolerance !== 0.001) throw new Error("Continuity policy must preserve the locked alignment tolerance.");
  return policy;
}

export function evaluateContinuity(signals: {
  frame: FrameSignal;
  pose: PoseComparison;
  features: FeatureEvaluation;
  mappability: RegionMappability;
}): ContinuityDecision {
  const statuses = [signals.frame.status, signals.pose.status, signals.features.status, signals.mappability.status];
  const gate = statuses.includes("FAIL") ? "CONTINUITY_FAIL" : statuses.includes("REVIEW") ? "CONTINUITY_REVIEW" : "CONTINUITY_PASS";
  const eligible = gate === "CONTINUITY_PASS";
  return {
    gate,
    reason_codes: [...new Set([
      ...signals.frame.reason_codes,
      ...signals.pose.reason_codes,
      ...signals.features.reason_codes,
      ...signals.mappability.reason_codes,
    ])],
    local_verification_eligibility: eligible ? "ELIGIBLE" : "BLOCKED",
    local_verification_state: eligible ? "LOCAL_VERIFICATION_ELIGIBLE" : "LOCAL_VERIFICATION_BLOCKED",
    interpretation: "Geometric eligibility only; not image quality, identity, accessibility, safety, or provider performance.",
  };
}

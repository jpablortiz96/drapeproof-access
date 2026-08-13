import { readFile } from "node:fs/promises";
import { createRegionMask } from "../verification/regions.js";
import type { NormalizedPoint, ProtectedRegion } from "../verification/types.js";
import type { PreserveAttempt, MappingEvidence, RepairOutcome } from "./types.js";

export const INTENT_ESTIMATOR_VERSION = "UpperBodyPoseIntentZoneV1" as const;

export type V2RepairOutcome = RepairOutcome | "REPAIR_BLOCKED_TRANSFORM_PROXIMITY";

export interface PreservePolicyV2 {
  name: "EXPERIMENTAL_PRESERVE_POLICY_V2";
  version: "2.0.0";
  validated: false;
  description: string;
  repair_implementation: "PRESERVE_ENGINE_V1";
  v1_policy_reference: {
    name: "EXPERIMENTAL_PRESERVE_POLICY_V1";
    version: "1.0.0";
    sha256: string;
    historical_primary_overlap_threshold: 0.35;
    historical_status: "FAIL_M8A";
  };
  intent: {
    provider_category: "upper_body";
    estimator: typeof INTENT_ESTIMATOR_VERSION;
    pose_implementation: "MediaPipe Pose Landmarker";
    pose_model_sha256: string;
    minimum_visibility: number;
    minimum_presence: number;
    required_landmarks: string[];
    upper_torso_apex_offset_ratio_of_shoulder_span: number;
  };
  guard_band: {
    minimum_normalized_margin: number;
    margin_ratio_of_shoulder_span: number;
    maximum_normalized_margin: number;
    include_v1_blend_footprint_minimum: true;
    negligible_raster_contact_max_pixels: number;
    minimum_clearance_beyond_footprints_normalized: number;
  };
  decision_logic: {
    block_on_intent_zone_unavailable: true;
    block_on_any_non_negligible_core_intersection: true;
    block_on_any_non_negligible_blend_intersection: true;
    block_on_insufficient_clearance: true;
    v1_visual_difference_overlap_is_evidence_only: true;
  };
}

export interface PoseLandmarkEvidence {
  index: number;
  name: string;
  x: number;
  y: number;
  visibility: number;
  presence: number;
}

export interface PoseEvidence {
  implementation: string;
  model: { sha256: string; name: string };
  poses_detected: number;
  landmarks: PoseLandmarkEvidence[];
}

export interface IntentZoneEstimate {
  status: "AVAILABLE" | "INTENT_ZONE_UNAVAILABLE";
  estimator: typeof INTENT_ESTIMATOR_VERSION;
  intent_source: "PROVIDER_USER_INTENT_UPPER_BODY";
  landmarks_used: Array<{ name: string; x: number; y: number; visibility: number; presence: number }>;
  missing_or_unreliable_landmarks: string[];
  shoulder_span_normalized: number | null;
  source_intent_polygon: NormalizedPoint[];
}

export interface IntentEligibilityEvidence {
  policy_name: PreservePolicyV2["name"];
  policy_version: PreservePolicyV2["version"];
  intent_estimator: typeof INTENT_ESTIMATOR_VERSION;
  intent_zone_status: IntentZoneEstimate["status"];
  decision: "ELIGIBLE" | "BLOCKED";
  decision_reason:
    | "ELIGIBLE"
    | "INTENT_ZONE_UNAVAILABLE"
    | "REPAIR_BLOCKED_ALIGNMENT"
    | "REPAIR_BLOCKED_CONTINUITY"
    | "REPAIR_BLOCKED_TRANSFORM_OVERLAP"
    | "REPAIR_BLOCKED_TRANSFORM_PROXIMITY"
    | "REPAIR_BLOCKED_INSUFFICIENT_CONTEXT";
  outcome_if_blocked: V2RepairOutcome | null;
  source_intent_polygon: NormalizedPoint[];
  mapped_intent_polygon: NormalizedPoint[];
  mapped_repair_polygon: NormalizedPoint[];
  guard_margin_normalized: number;
  guard_radius_pixels: { x: number; y: number };
  protected_core_pixels: number;
  blend_band_pixels: number;
  repair_footprint_pixels: number;
  exclusion_zone_pixels: number;
  core_intersection_pixels: number;
  protected_core_intersection_ratio: number;
  blend_band_intersection_pixels: number;
  blend_band_intersection_ratio: number;
  total_intersection_pixels: number;
  negligible_contact_max_pixels: number;
  minimum_separation_pixels: number | null;
  minimum_separation_normalized: number | null;
  required_minimum_clearance_normalized: number;
  v1_visual_difference_overlap: {
    pixels: number;
    ratio: number;
    historical_threshold: number;
    primary_decision_input: false;
  };
}

export interface IntentAwareEvaluation {
  evidence: IntentEligibilityEvidence;
  sourceIntentMask: Buffer;
  mappedIntentMask: Buffer;
  exclusionZoneMask: Buffer;
  repairFootprintMask: Buffer;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown, label: string, minimum = 0, maximum = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid V2 preserve policy field: ${label}.`);
  return value;
}

export function validatePreservePolicyV2(value: unknown): PreservePolicyV2 {
  if (!record(value) || value.name !== "EXPERIMENTAL_PRESERVE_POLICY_V2" || value.version !== "2.0.0" || value.validated !== false || value.repair_implementation !== "PRESERVE_ENGINE_V1") {
    throw new Error("Invalid V2 preserve policy identity.");
  }
  if (!record(value.v1_policy_reference) || value.v1_policy_reference.name !== "EXPERIMENTAL_PRESERVE_POLICY_V1" || value.v1_policy_reference.historical_primary_overlap_threshold !== 0.35 || value.v1_policy_reference.historical_status !== "FAIL_M8A") {
    throw new Error("V2 must preserve the historical failed V1 policy reference and 35% threshold.");
  }
  if (!record(value.intent) || value.intent.provider_category !== "upper_body" || value.intent.estimator !== INTENT_ESTIMATOR_VERSION || !Array.isArray(value.intent.required_landmarks)) throw new Error("Invalid V2 upper-body intent policy.");
  number(value.intent.minimum_visibility, "intent.minimum_visibility", 0, 1);
  number(value.intent.minimum_presence, "intent.minimum_presence", 0, 1);
  number(value.intent.upper_torso_apex_offset_ratio_of_shoulder_span, "intent.upper_torso_apex_offset_ratio_of_shoulder_span", 0, 1);
  if (!record(value.guard_band)) throw new Error("V2 guard band is required.");
  const minimum = number(value.guard_band.minimum_normalized_margin, "guard_band.minimum_normalized_margin", 0, 0.25);
  number(value.guard_band.margin_ratio_of_shoulder_span, "guard_band.margin_ratio_of_shoulder_span", 0, 0.5);
  const maximum = number(value.guard_band.maximum_normalized_margin, "guard_band.maximum_normalized_margin", minimum, 0.5);
  if (maximum < minimum || value.guard_band.include_v1_blend_footprint_minimum !== true) throw new Error("Invalid V2 guard band bounds.");
  const contact = number(value.guard_band.negligible_raster_contact_max_pixels, "guard_band.negligible_raster_contact_max_pixels", 0, 16);
  if (!Number.isInteger(contact)) throw new Error("Negligible contact must be an integer pixel count.");
  number(value.guard_band.minimum_clearance_beyond_footprints_normalized, "guard_band.minimum_clearance_beyond_footprints_normalized", 0, 0.1);
  if (!record(value.decision_logic) || Object.values(value.decision_logic).some((item) => item !== true)) throw new Error("Every V2 conservative decision rule must be enabled.");
  return value as unknown as PreservePolicyV2;
}

export async function readPreservePolicyV2(path: string): Promise<PreservePolicyV2> {
  return validatePreservePolicyV2(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function cross(origin: NormalizedPoint, left: NormalizedPoint, right: NormalizedPoint): number {
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

export function convexHull(points: NormalizedPoint[]): NormalizedPoint[] {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length <= 2) return sorted;
  const lower: NormalizedPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: NormalizedPoint[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export interface TransformationIntentZoneEstimator {
  readonly version: typeof INTENT_ESTIMATOR_VERSION;
  estimate(pose: PoseEvidence, policy: PreservePolicyV2): IntentZoneEstimate;
}

export class UpperBodyPoseIntentZoneV1 implements TransformationIntentZoneEstimator {
  readonly version = INTENT_ESTIMATOR_VERSION;

  estimate(pose: PoseEvidence, policy: PreservePolicyV2): IntentZoneEstimate {
    const reliable = new Map(pose.landmarks
      .filter((item) => item.visibility >= policy.intent.minimum_visibility && item.presence >= policy.intent.minimum_presence && item.x >= 0 && item.x <= 1 && item.y >= 0 && item.y <= 1)
      .map((item) => [item.name, item]));
    const missing = policy.intent.required_landmarks.filter((name) => !reliable.has(name));
    const used = policy.intent.required_landmarks.flatMap((name) => {
      const item = reliable.get(name);
      return item ? [{ name: item.name, x: item.x, y: item.y, visibility: item.visibility, presence: item.presence }] : [];
    });
    if (pose.poses_detected !== 1 || pose.implementation !== policy.intent.pose_implementation || pose.model.sha256 !== policy.intent.pose_model_sha256 || missing.length > 0) {
      return { status: "INTENT_ZONE_UNAVAILABLE", estimator: this.version, intent_source: "PROVIDER_USER_INTENT_UPPER_BODY", landmarks_used: used, missing_or_unreliable_landmarks: missing, shoulder_span_normalized: null, source_intent_polygon: [] };
    }
    const leftShoulder = reliable.get("left-shoulder")!;
    const rightShoulder = reliable.get("right-shoulder")!;
    const shoulderSpan = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y);
    const apex = {
      x: (leftShoulder.x + rightShoulder.x) / 2,
      y: Math.max(0, Math.min(leftShoulder.y, rightShoulder.y) - shoulderSpan * policy.intent.upper_torso_apex_offset_ratio_of_shoulder_span),
    };
    return {
      status: "AVAILABLE",
      estimator: this.version,
      intent_source: "PROVIDER_USER_INTENT_UPPER_BODY",
      landmarks_used: used,
      missing_or_unreliable_landmarks: [],
      shoulder_span_normalized: shoulderSpan,
      source_intent_polygon: convexHull([...used.map(({ x, y }) => ({ x, y })), apex]),
    };
  }
}

function mapPoint(point: NormalizedPoint, mapping: MappingEvidence): NormalizedPoint {
  const [a, b, c, d, e, f] = mapping.source_to_target_normalized;
  return { x: a * point.x + b * point.y + c, y: d * point.x + e * point.y + f };
}

function count(mask: Buffer): number {
  let result = 0;
  for (const item of mask) if (item) result += 1;
  return result;
}

function subtract(outer: Buffer, inner: Buffer): Buffer {
  const result = Buffer.alloc(outer.length);
  for (let index = 0; index < result.length; index += 1) result[index] = outer[index] && !inner[index] ? 1 : 0;
  return result;
}

function intersections(left: Buffer, right: Buffer): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] && right[index]) result += 1;
  return result;
}

export function expandMaskNormalized(mask: Buffer, width: number, height: number, margin: number): { mask: Buffer; radius: { x: number; y: number } } {
  const radiusX = Math.max(1, Math.ceil(width * margin));
  const radiusY = Math.max(1, Math.ceil(height * margin));
  const horizontal = Buffer.alloc(mask.length);
  for (let y = 0; y < height; y += 1) {
    const prefix = new Uint32Array(width + 1);
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x]! + (mask[y * width + x] ? 1 : 0);
    for (let x = 0; x < width; x += 1) if (prefix[Math.min(width, x + radiusX + 1)]! - prefix[Math.max(0, x - radiusX)]! > 0) horizontal[y * width + x] = 1;
  }
  const expanded = Buffer.alloc(mask.length);
  for (let x = 0; x < width; x += 1) {
    const prefix = new Uint32Array(height + 1);
    for (let y = 0; y < height; y += 1) prefix[y + 1] = prefix[y]! + (horizontal[y * width + x] ? 1 : 0);
    for (let y = 0; y < height; y += 1) if (prefix[Math.min(height, y + radiusY + 1)]! - prefix[Math.max(0, y - radiusY)]! > 0) expanded[y * width + x] = 1;
  }
  return { mask: expanded, radius: { x: radiusX, y: radiusY } };
}

function minimumChebyshevSeparation(left: Buffer, right: Buffer, width: number, height: number): number | null {
  if (intersections(left, right) > 0) return 0;
  const distance = new Int32Array(left.length);
  distance.fill(-1);
  const queue = new Int32Array(left.length);
  let head = 0, tail = 0;
  for (let index = 0; index < right.length; index += 1) if (right[index]) { distance[index] = 0; queue[tail++] = index; }
  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width, y = Math.floor(index / width), nextDistance = distance[index]! + 1;
    for (let dy = -1; dy <= 1; dy += 1) {
      const nextY = y + dy;
      if (nextY < 0 || nextY >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const nextX = x + dx;
        if (nextX < 0 || nextX >= width) continue;
        const next = nextY * width + nextX;
        if (distance[next] !== -1) continue;
        distance[next] = nextDistance;
        if (left[next]) return nextDistance;
        queue[tail++] = next;
      }
    }
  }
  return null;
}

export function evaluateIntentAwareEligibility(options: {
  attempt: PreserveAttempt;
  intent: IntentZoneEstimate;
  policy: PreservePolicyV2;
}): IntentAwareEvaluation {
  const { attempt, intent, policy } = options;
  const { width, height } = attempt.repaired;
  const empty = () => Buffer.alloc(width * height);
  const mappedIntent = intent.source_intent_polygon.map((point) => mapPoint(point, attempt.input.mapping));
  const intentMappable = intent.status === "AVAILABLE" && mappedIntent.length >= 3 && mappedIntent.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
  const sourceIntentMask = intent.status === "AVAILABLE" ? createRegionMask({ id: "upper-body-intent-source", label: "Upper-body intent", polygon: intent.source_intent_polygon }, width, height) : empty();
  const mappedIntentMask = intentMappable ? createRegionMask({ id: "upper-body-intent-target", label: "Upper-body intent", polygon: mappedIntent }, width, height) : empty();
  const blendNormalized = attempt.input.policy.context.blend_band_pixels / Math.min(width, height);
  const guardMargin = Math.min(policy.guard_band.maximum_normalized_margin, Math.max(
    policy.guard_band.minimum_normalized_margin,
    (intent.shoulder_span_normalized ?? 0) * policy.guard_band.margin_ratio_of_shoulder_span,
    blendNormalized,
  ));
  const expanded = intentMappable ? expandMaskNormalized(mappedIntentMask, width, height, guardMargin) : { mask: empty(), radius: { x: 0, y: 0 } };
  const bandOnly = subtract(attempt.blendMask, attempt.coreMask);
  const corePixels = count(attempt.coreMask), bandPixels = count(bandOnly), footprintPixels = count(attempt.blendMask);
  const coreIntersection = intersections(attempt.coreMask, expanded.mask);
  const bandIntersection = intersections(bandOnly, expanded.mask);
  const totalIntersection = coreIntersection + bandIntersection;
  const separationPixels = intentMappable ? minimumChebyshevSeparation(attempt.blendMask, expanded.mask, width, height) : null;
  const separationNormalized = separationPixels === null ? null : separationPixels / Math.min(width, height);
  let decisionReason: IntentEligibilityEvidence["decision_reason"] = "ELIGIBLE";
  let outcome: V2RepairOutcome | null = null;
  if (attempt.eligibility.checks.continuity === "BLOCKED") {
    decisionReason = "REPAIR_BLOCKED_CONTINUITY";
    outcome = "REPAIR_BLOCKED_CONTINUITY";
  } else if (attempt.eligibility.checks.mapping === "BLOCKED" || attempt.eligibility.checks.bounds === "BLOCKED" || (intent.status === "AVAILABLE" && !intentMappable)) {
    decisionReason = "REPAIR_BLOCKED_ALIGNMENT";
    outcome = "REPAIR_BLOCKED_ALIGNMENT";
  } else if (intent.status === "INTENT_ZONE_UNAVAILABLE") {
    decisionReason = "INTENT_ZONE_UNAVAILABLE";
    outcome = "REPAIR_BLOCKED_TRANSFORM_OVERLAP";
  } else if (totalIntersection > policy.guard_band.negligible_raster_contact_max_pixels) {
    decisionReason = "REPAIR_BLOCKED_TRANSFORM_OVERLAP";
    outcome = "REPAIR_BLOCKED_TRANSFORM_OVERLAP";
  } else if (separationNormalized !== null && separationNormalized < policy.guard_band.minimum_clearance_beyond_footprints_normalized) {
    decisionReason = "REPAIR_BLOCKED_TRANSFORM_PROXIMITY";
    outcome = "REPAIR_BLOCKED_TRANSFORM_PROXIMITY";
  } else if (attempt.eligibility.checks.context === "BLOCKED") {
    decisionReason = "REPAIR_BLOCKED_INSUFFICIENT_CONTEXT";
    outcome = "REPAIR_BLOCKED_INSUFFICIENT_CONTEXT";
  }
  return {
    evidence: {
      policy_name: policy.name,
      policy_version: policy.version,
      intent_estimator: INTENT_ESTIMATOR_VERSION,
      intent_zone_status: intent.status,
      decision: outcome ? "BLOCKED" : "ELIGIBLE",
      decision_reason: decisionReason,
      outcome_if_blocked: outcome,
      source_intent_polygon: intent.source_intent_polygon,
      mapped_intent_polygon: mappedIntent,
      mapped_repair_polygon: attempt.mapping.target_polygon,
      guard_margin_normalized: guardMargin,
      guard_radius_pixels: expanded.radius,
      protected_core_pixels: corePixels,
      blend_band_pixels: bandPixels,
      repair_footprint_pixels: footprintPixels,
      exclusion_zone_pixels: count(expanded.mask),
      core_intersection_pixels: coreIntersection,
      protected_core_intersection_ratio: coreIntersection / Math.max(1, corePixels),
      blend_band_intersection_pixels: bandIntersection,
      blend_band_intersection_ratio: bandIntersection / Math.max(1, bandPixels),
      total_intersection_pixels: totalIntersection,
      negligible_contact_max_pixels: policy.guard_band.negligible_raster_contact_max_pixels,
      minimum_separation_pixels: separationPixels,
      minimum_separation_normalized: separationNormalized,
      required_minimum_clearance_normalized: policy.guard_band.minimum_clearance_beyond_footprints_normalized,
      v1_visual_difference_overlap: {
        pixels: attempt.eligibility.overlap_pixels,
        ratio: attempt.eligibility.overlap_ratio,
        historical_threshold: policy.v1_policy_reference.historical_primary_overlap_threshold,
        primary_decision_input: false,
      },
    },
    sourceIntentMask,
    mappedIntentMask,
    exclusionZoneMask: expanded.mask,
    repairFootprintMask: Buffer.from(attempt.blendMask),
  };
}

export interface PreregisteredControl {
  id: "SAFE_EXTERNAL_REGION" | "GUARD_BAND_CONTACT" | "PARTIAL_INTENT_OVERLAP" | "DEEP_INTENT_OVERLAP" | "INVALID_MAPPING" | "CONTINUITY_BLOCK";
  expected: "ELIGIBLE" | V2RepairOutcome;
  region: ProtectedRegion;
  setup: "NORMAL" | "INVALID_MAPPING" | "CONTINUITY_FAILURE_FIXTURE";
}

function rectangle(id: string, label: string, left: number, top: number, right: number, bottom: number): ProtectedRegion {
  const bounded = (value: number) => Math.max(0, Math.min(1, value));
  return { id, label, polygon: [{ x: bounded(left), y: bounded(top) }, { x: bounded(right), y: bounded(top) }, { x: bounded(right), y: bounded(bottom) }, { x: bounded(left), y: bounded(bottom) }] };
}

export function buildPreregisteredControls(intent: IntentZoneEstimate, guardMargin: number): PreregisteredControl[] {
  if (intent.status !== "AVAILABLE") throw new Error("Cannot preregister controls without an intent zone.");
  const left = Math.min(...intent.source_intent_polygon.map((point) => point.x));
  const right = Math.max(...intent.source_intent_polygon.map((point) => point.x));
  const top = Math.min(...intent.source_intent_polygon.map((point) => point.y));
  const bottom = Math.max(...intent.source_intent_polygon.map((point) => point.y));
  const midY = top + (bottom - top) * 0.58;
  const safe = rectangle("control-safe-external", "SAFE EXTERNAL CONTROL", 0.82, 0.64, 0.88, 0.70);
  return [
    { id: "SAFE_EXTERNAL_REGION", expected: "ELIGIBLE", region: safe, setup: "NORMAL" },
    { id: "GUARD_BAND_CONTACT", expected: "REPAIR_BLOCKED_TRANSFORM_OVERLAP", region: rectangle("control-guard-contact", "GUARD-BAND CONTROL", right + guardMargin - 0.006, midY - 0.025, right + guardMargin + 0.044, midY + 0.025), setup: "NORMAL" },
    { id: "PARTIAL_INTENT_OVERLAP", expected: "REPAIR_BLOCKED_TRANSFORM_OVERLAP", region: rectangle("control-partial-overlap", "PARTIAL-OVERLAP CONTROL", right - 0.008, midY - 0.045, right + 0.082, midY + 0.045), setup: "NORMAL" },
    { id: "DEEP_INTENT_OVERLAP", expected: "REPAIR_BLOCKED_TRANSFORM_OVERLAP", region: rectangle("control-deep-overlap", "DEEP-OVERLAP CONTROL", left + (right - left) * 0.37, top + (bottom - top) * 0.30, left + (right - left) * 0.63, top + (bottom - top) * 0.68), setup: "NORMAL" },
    { id: "INVALID_MAPPING", expected: "REPAIR_BLOCKED_ALIGNMENT", region: { ...safe, id: "control-invalid-mapping", label: "INVALID MAPPING CONTROL" }, setup: "INVALID_MAPPING" },
    { id: "CONTINUITY_BLOCK", expected: "REPAIR_BLOCKED_CONTINUITY", region: { ...safe, id: "control-continuity-block", label: "CONTINUITY BLOCK CONTROL" }, setup: "CONTINUITY_FAILURE_FIXTURE" },
  ];
}

import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import type { ProtectedRegion, RawImage } from "../src/verification/types.js";
import type { SessionContinuityResult } from "../src/product/live/types.js";
import { DeterministicSourceRestoreV1, identityMapping } from "../src/preserve/engine.js";
import { readPreservePolicy } from "../src/preserve/policy.js";
import type { PreservePolicy, VerificationSnapshot } from "../src/preserve/types.js";
import {
  buildPreregisteredControls,
  evaluateIntentAwareEligibility,
  expandMaskNormalized,
  readPreservePolicyV2,
  UpperBodyPoseIntentZoneV1,
  type IntentZoneEstimate,
  type PoseEvidence,
  type PreservePolicyV2,
} from "../src/preserve/v2-intent.js";
import { withPreserveWorkspace } from "../src/preserve/workspace.js";

let v1: PreservePolicy;
let v2: PreservePolicyV2;
beforeAll(async () => {
  [v1, v2] = await Promise.all([
    readPreservePolicy(resolve("config/preserve-policy.json")),
    readPreservePolicyV2(resolve("config/preserve-policy-v2.json")),
  ]);
});

const continuity: SessionContinuityResult = { state: "CONSISTENT", localVerificationEligible: true, reasonCodes: [], signals: [] };
const zeroMeasurements: VerificationSnapshot = {
  decision: "PRESERVED",
  measurements: {
    mean_absolute_difference: { normalized: 0, raw_absolute_channel_sum: 0, compared_channels: 3, range: "0..1" },
    changed_pixel_ratio: { tolerance_8bit: 12, changed_pixels: 0, total_region_pixels: 1, ratio: 0, per_pixel_rule: "maximum RGB channel difference exceeds tolerance" },
    ssim: { value: 1, range: "-1..1", implementation: "global grayscale SSIM formula", k1: 0.01, k2: 0.03, dynamic_range: 255 },
    edge_difference: { sobel_threshold_normalized: 0.1, original_edge_pixels: 0, generated_edge_pixels: 0, mismatched_edge_pixels: 0, total_region_pixels: 1, ratio: 0, range: "0..1" },
  },
};

function pose(missing?: string): PoseEvidence {
  const points: Record<string, [number, number]> = {
    "left-shoulder": [0.65, 0.30], "right-shoulder": [0.35, 0.30],
    "left-elbow": [0.75, 0.45], "right-elbow": [0.25, 0.45],
    "left-wrist": [0.80, 0.58], "right-wrist": [0.20, 0.58],
    "left-hip": [0.58, 0.66], "right-hip": [0.42, 0.66],
  };
  return {
    implementation: "MediaPipe Pose Landmarker",
    model: { sha256: v2.intent.pose_model_sha256, name: "test" },
    poses_detected: 1,
    landmarks: Object.entries(points).filter(([name]) => name !== missing).map(([name, [x, y]], index) => ({ index, name, x, y, visibility: 0.99, presence: 0.99 })),
  };
}

function rectangle(id: string, left: number, top: number, right: number, bottom: number, label = id): ProtectedRegion {
  return { id, label, polygon: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
}

function image(width = 600, height = 800): RawImage {
  return { width, height, channels: 3, data: Buffer.alloc(width * height * 3, 96) };
}

function evaluate(region: ProtectedRegion, intent: IntentZoneEstimate, options: { mappingStable?: boolean; continuity?: SessionContinuityResult; width?: number; height?: number } = {}) {
  const source = image(options.width, options.height);
  const mapping = { ...identityMapping(100, 0.95), stable: options.mappingStable ?? true };
  const attempt = new DeterministicSourceRestoreV1().attempt({
    sessionId: "m8a1-test",
    sourceHash: "source",
    providerResultHash: "provider",
    generatedInputHash: "provider",
    generatedInputProvenance: "REAL_PROVIDER_RESULT",
    source,
    transformationReference: source,
    providerResult: source,
    region,
    continuity: options.continuity ?? continuity,
    mapping,
    initialVerification: zeroMeasurements,
    policy: v1,
  });
  return evaluateIntentAwareEligibility({ attempt, intent, policy: v2 });
}

describe("intent-aware repair eligibility", () => {
  it("builds the upper-body intent polygon deterministically from the locked pose landmarks", () => {
    const estimator = new UpperBodyPoseIntentZoneV1();
    const first = estimator.estimate(pose(), v2);
    const second = estimator.estimate(pose(), v2);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "AVAILABLE", estimator: "UpperBodyPoseIntentZoneV1", intent_source: "PROVIDER_USER_INTENT_UPPER_BODY" });
    expect(first.landmarks_used.map((item) => item.name)).toEqual(v2.intent.required_landmarks);
    expect(first.source_intent_polygon.length).toBeGreaterThanOrEqual(6);
  });

  it("blocks conservatively with INTENT_ZONE_UNAVAILABLE when a required landmark is missing", () => {
    const intent = new UpperBodyPoseIntentZoneV1().estimate(pose("left-shoulder"), v2);
    const result = evaluate(rectangle("external", 0.88, 0.78, 0.94, 0.84), intent);
    expect(result.evidence).toMatchObject({ intent_zone_status: "INTENT_ZONE_UNAVAILABLE", decision: "BLOCKED", decision_reason: "INTENT_ZONE_UNAVAILABLE", outcome_if_blocked: "REPAIR_BLOCKED_TRANSFORM_OVERLAP" });
  });

  it("expands a deterministic normalized guard band in both image axes", () => {
    const mask = Buffer.alloc(100 * 200); mask[100 * 100 + 50] = 1;
    const expanded = expandMaskNormalized(mask, 100, 200, 0.02);
    expect(expanded.radius).toEqual({ x: 2, y: 4 });
    expect(expanded.mask[100 * 100 + 48]).toBe(1);
    expect(expanded.mask[96 * 100 + 50]).toBe(1);
  });

  it("maps the source intent zone with the same target transform and blocks invalid alignment", () => {
    const intent = new UpperBodyPoseIntentZoneV1().estimate(pose(), v2);
    const invalid = evaluate(rectangle("external", 0.88, 0.78, 0.94, 0.84), intent, { mappingStable: false });
    expect(invalid.evidence.decision_reason).toBe("REPAIR_BLOCKED_ALIGNMENT");
    expect(invalid.evidence.mapped_intent_polygon).toEqual(intent.source_intent_polygon);
  });

  it("blocks protected-core and blend-band intersections without using V1's 35% threshold", () => {
    const intent = new UpperBodyPoseIntentZoneV1().estimate(pose(), v2);
    const deep = evaluate(rectangle("deep", 0.44, 0.36, 0.56, 0.50), intent);
    expect(deep.evidence.core_intersection_pixels).toBeGreaterThan(0);
    expect(deep.evidence.decision_reason).toBe("REPAIR_BLOCKED_TRANSFORM_OVERLAP");
    const edge = evaluate(rectangle("edge", 0.81, 0.48, 0.85, 0.54), intent);
    expect(edge.evidence.total_intersection_pixels).toBeGreaterThan(2);
    expect(edge.evidence.decision_reason).toBe("REPAIR_BLOCKED_TRANSFORM_OVERLAP");
    expect(edge.evidence.v1_visual_difference_overlap.primary_decision_input).toBe(false);
  });

  it("records minimum safe distance and permits a genuinely external region", () => {
    const intent = new UpperBodyPoseIntentZoneV1().estimate(pose(), v2);
    const external = evaluate(rectangle("wheelchair-joystick", 0.88, 0.78, 0.94, 0.84, "Joystick/control metadata"), intent);
    expect(external.evidence).toMatchObject({ decision: "ELIGIBLE", decision_reason: "ELIGIBLE" });
    expect(external.evidence.minimum_separation_normalized).toBeGreaterThanOrEqual(v2.guard_band.minimum_clearance_beyond_footprints_normalized);
  });

  it("blocks insufficient non-intersecting clearance as transform proximity", () => {
    const intent: IntentZoneEstimate = {
      status: "AVAILABLE", estimator: "UpperBodyPoseIntentZoneV1", intent_source: "PROVIDER_USER_INTENT_UPPER_BODY", landmarks_used: [], missing_or_unreliable_landmarks: [], shoulder_span_normalized: 0.2,
      source_intent_polygon: rectangle("intent", 0.2, 0.2, 0.4, 0.4).polygon,
    };
    const near = evaluate(rectangle("near", 0.4348, 0.25, 0.48, 0.35), intent);
    expect(near.evidence.total_intersection_pixels).toBeLessThanOrEqual(v2.guard_band.negligible_raster_contact_max_pixels);
    expect(near.evidence.decision_reason).toBe("REPAIR_BLOCKED_TRANSFORM_PROXIMITY");
  });

  it("pre-registers safe, guard, partial, deep, alignment, and continuity controls without category or filename semantics", () => {
    const intent = new UpperBodyPoseIntentZoneV1().estimate(pose(), v2);
    const guard = Math.max(v2.guard_band.minimum_normalized_margin, intent.shoulder_span_normalized! * v2.guard_band.margin_ratio_of_shoulder_span);
    const controls = buildPreregisteredControls(intent, guard);
    expect(controls.map((item) => item.id)).toEqual(["SAFE_EXTERNAL_REGION", "GUARD_BAND_CONTACT", "PARTIAL_INTENT_OVERLAP", "DEEP_INTENT_OVERLAP", "INVALID_MAPPING", "CONTINUITY_BLOCK"]);
    const deep = controls.find((item) => item.id === "DEEP_INTENT_OVERLAP")!;
    const renamed = evaluate({ ...deep.region, id: "arbitrary", label: "arbitrary metadata" }, intent);
    expect(renamed.evidence.decision_reason).toBe("REPAIR_BLOCKED_TRANSFORM_OVERLAP");
  });

  it("preserves continuity as a higher-priority conservative block", () => {
    const intent = new UpperBodyPoseIntentZoneV1().estimate(pose(), v2);
    const failed: SessionContinuityResult = { state: "CHANGED_TOO_MUCH", localVerificationEligible: false, reasonCodes: ["CONTINUITY_FAIL_FIXTURE"], signals: [] };
    const result = evaluate(rectangle("external", 0.88, 0.78, 0.94, 0.84), intent, { continuity: failed });
    expect(result.evidence.decision_reason).toBe("REPAIR_BLOCKED_CONTINUITY");
  });

  it("removes private OS-temp workspaces after success, blocked work, and exceptions", async () => {
    for (const mode of ["success", "blocked"] as const) {
      let workspace = "";
      await withPreserveWorkspace(async (path) => { workspace = path; await writeFile(join(path, "private.bin"), mode); return mode; });
      await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    }
    let failedWorkspace = "";
    await expect(withPreserveWorkspace(async (path) => { failedWorkspace = path; await writeFile(join(path, "private.bin"), "failure"); throw new Error("expected"); })).rejects.toThrow("expected");
    await expect(access(failedWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps V1 immutable, restoration math unchanged, provider-free, and evidence-isolated", async () => {
    const [v1Text, v2Text, engine, v2Source] = await Promise.all([
      import("node:fs/promises").then(({ readFile }) => readFile(resolve("config/preserve-policy.json"), "utf8")),
      import("node:fs/promises").then(({ readFile }) => readFile(resolve("config/preserve-policy-v2.json"), "utf8")),
      import("node:fs/promises").then(({ readFile }) => readFile(resolve("src/preserve/engine.ts"), "utf8")),
      import("node:fs/promises").then(({ readFile }) => readFile(resolve("src/preserve/v2-intent.ts"), "utf8")),
    ]);
    expect(JSON.parse(v1Text)).toMatchObject({ name: "EXPERIMENTAL_PRESERVE_POLICY_V1", transformation_zone: { block_at_or_above_overlap_ratio: 0.35 } });
    expect(JSON.parse(v2Text)).toMatchObject({ name: "EXPERIMENTAL_PRESERVE_POLICY_V2", v1_policy_reference: { historical_status: "NOT_VALIDATED" } });
    expect(`${engine}\n${v2Source}`).not.toMatch(/YouCamClient|YOUCAM_API_KEY|provider\.start|provider\.poll/);
    await expect(access(resolve("web/app/api/m8a_1/route.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

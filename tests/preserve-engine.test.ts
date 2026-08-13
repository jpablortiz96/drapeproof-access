import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { measureRegion } from "../src/verification/metrics.js";
import { evaluatePolicy, readPolicy } from "../src/verification/policy.js";
import { createRegionMask } from "../src/verification/regions.js";
import type { PolicyDecision, PreservationPolicy, ProtectedRegion, RawImage, RegionMeasurements } from "../src/verification/types.js";
import type { SessionContinuityResult } from "../src/product/live/types.js";
import {
  completePreservationTrace,
  DeterministicSourceRestoreV1,
  identityMapping,
  outerRingPass,
  transformationZoneMask,
  warpSourceToTarget,
} from "../src/preserve/engine.js";
import { readPreservePolicy } from "../src/preserve/policy.js";
import type { MappingEvidence, PreserveAttemptInput, PreservePolicy, VerificationSnapshot } from "../src/preserve/types.js";

const width = 64;
const height = 64;
const region: ProtectedRegion = {
  id: "protected-control",
  label: "Protected control",
  polygon: [{ x: 0.3, y: 0.3 }, { x: 0.65, y: 0.3 }, { x: 0.65, y: 0.65 }, { x: 0.3, y: 0.65 }],
};
const continuity: SessionContinuityResult = {
  state: "CONSISTENT",
  localVerificationEligible: true,
  reasonCodes: [],
  signals: [],
};
let preservePolicy: PreservePolicy;
let regionPolicy: PreservationPolicy;

beforeAll(async () => {
  [preservePolicy, regionPolicy] = await Promise.all([
    readPreservePolicy(resolve("config/preserve-policy.json")),
    readPolicy(resolve("config/preservation-policy.json")),
  ]);
});

function image(seed = 0): RawImage {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      data[offset] = (31 + x + seed) % 256;
      data[offset + 1] = (53 + y + seed) % 256;
      data[offset + 2] = (71 + x + y + seed) % 256;
    }
  }
  return { data, width, height, channels: 3 };
}

function mutateInside(input: RawImage, target = region, delta = 80): RawImage {
  const output = { ...input, data: Buffer.from(input.data) };
  const mask = createRegionMask(target, width, height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const offset = pixel * 3 + channel;
      output.data[offset] = Math.max(0, Math.min(255, output.data[offset]! + delta));
    }
  }
  return output;
}

function snapshot(original: RawImage, generated: RawImage, target = region): VerificationSnapshot {
  const mask = createRegionMask(target, width, height);
  const measurements = measureRegion(original, generated, mask, regionPolicy.pixel_tolerance_8bit, regionPolicy.sobel_edge_threshold_normalized).measurements;
  return { decision: evaluatePolicy(measurements, regionPolicy).decision, measurements };
}

function input(overrides: Partial<PreserveAttemptInput> = {}): PreserveAttemptInput {
  const source = image();
  const generated = mutateInside(source);
  return {
    sessionId: "preserve-test-session",
    sourceHash: "source-hash",
    providerResultHash: "immutable-provider-hash",
    generatedInputHash: "generated-input-hash",
    generatedInputProvenance: "REAL_PROVIDER_RESULT",
    source,
    transformationReference: source,
    providerResult: generated,
    region,
    continuity,
    mapping: identityMapping(100, 0.95),
    initialVerification: snapshot(source, generated),
    policy: preservePolicy,
    ...overrides,
  };
}

function measurements(values: { mad: number; changed: number; ssim: number; edge: number }): RegionMeasurements {
  return {
    mean_absolute_difference: { normalized: values.mad, raw_absolute_channel_sum: 0, compared_channels: 1, range: "0..1" },
    changed_pixel_ratio: { tolerance_8bit: 12, changed_pixels: 0, total_region_pixels: 1, ratio: values.changed, per_pixel_rule: "maximum RGB channel difference exceeds tolerance" },
    ssim: { value: values.ssim, range: "-1..1", implementation: "global grayscale SSIM formula", k1: 0.01, k2: 0.03, dynamic_range: 255 },
    edge_difference: { sobel_threshold_normalized: 0.1, original_edge_pixels: 0, generated_edge_pixels: 0, mismatched_edge_pixels: 0, total_region_pixels: 1, ratio: values.edge, range: "0..1" },
  };
}

describe("deterministic preserve engine", () => {
  it("loads an explicitly experimental, unvalidated, score-free policy", () => {
    expect(preservePolicy).toMatchObject({ name: "EXPERIMENTAL_PRESERVE_POLICY_V1", validated: false, repair_implementation: "PRESERVE_ENGINE_V1" });
    expect(JSON.stringify(preservePolicy)).not.toMatch(/score/i);
  });

  it("restores the protected core exactly, feathers only the blend band, and leaves all other pixels unchanged", () => {
    const attempt = new DeterministicSourceRestoreV1().attempt(input());
    let core = 0, band = 0, outside = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 3;
      if (attempt.coreMask[pixel]) {
        core += 1;
        expect(attempt.repaired.data.subarray(offset, offset + 3)).toEqual(attempt.mappedSource.data.subarray(offset, offset + 3));
      } else if (attempt.blendMask[pixel]) {
        band += 1;
      } else {
        outside += 1;
        expect(attempt.repaired.data.subarray(offset, offset + 3)).toEqual(attempt.input.providerResult.data.subarray(offset, offset + 3));
      }
    }
    expect({ core, band, outside }).toMatchObject({ core: expect.any(Number), band: expect.any(Number), outside: expect.any(Number) });
    expect(core).toBeGreaterThan(0);
    expect(band).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  it("uses the protected-region verifier and produces RESTORED with a passing outer safety ring", () => {
    const engineInput = input();
    const attempt = new DeterministicSourceRestoreV1().attempt(engineInput);
    const final = snapshot(engineInput.source, attempt.repaired);
    const trace = completePreservationTrace(attempt, final);
    expect(engineInput.initialVerification.decision).toBe("CHANGED");
    expect(final.decision).toBe("PRESERVED");
    expect(trace.outcome).toBe("RESTORED");
    expect(trace.outer_ring_verification.passed).toBe(true);
    expect(trace.provider_calls).toBe(0);
    expect(trace.youcam_units).toBe(0);
  });

  it("blocks inconsistent continuity and unstable or out-of-bounds mappings", () => {
    const engine = new DeterministicSourceRestoreV1();
    const blockedContinuity = engine.attempt(input({ continuity: { ...continuity, state: "NEEDS_REVIEW", localVerificationEligible: false } }));
    expect(blockedContinuity.provisionalOutcome).toBe("REPAIR_BLOCKED_CONTINUITY");
    const unstable = engine.attempt(input({ mapping: { ...identityMapping(0, 0), stable: false } }));
    expect(unstable.provisionalOutcome).toBe("REPAIR_BLOCKED_ALIGNMENT");
    const outside = engine.attempt(input({ mapping: { ...identityMapping(100, 1), source_to_target_normalized: [1, 0, 0.8, 0, 1, 0] } }));
    expect(outside.provisionalOutcome).toBe("REPAIR_BLOCKED_ALIGNMENT");
  });

  it("blocks transformation overlap generically from immutable image evidence", () => {
    const source = image();
    const transformed = mutateInside(source);
    const attempt = new DeterministicSourceRestoreV1().attempt(input({
      source,
      transformationReference: transformed,
      providerResult: transformed,
      initialVerification: snapshot(source, transformed),
    }));
    expect(attempt.eligibility.overlap_ratio).toBeGreaterThanOrEqual(preservePolicy.transformation_zone.block_at_or_above_overlap_ratio);
    expect(attempt.provisionalOutcome).toBe("REPAIR_BLOCKED_TRANSFORM_OVERLAP");
    expect(attempt.changeAccounting.modified_pixels).toBe(0);
  });

  it("keeps synthetic control damage distinct from the immutable transformation reference", () => {
    const source = image();
    const mutation = mutateInside(source);
    const attempt = new DeterministicSourceRestoreV1().attempt(input({
      source,
      transformationReference: source,
      providerResult: mutation,
      providerResultHash: "real-provider-hash",
      generatedInputHash: "synthetic-mutation-hash",
      generatedInputProvenance: "SYNTHETIC_CONTROL_MUTATION",
      initialVerification: snapshot(source, mutation),
    }));
    const trace = completePreservationTrace(attempt, snapshot(source, attempt.repaired));
    expect(attempt.eligibility.checks.transformation_overlap).toBe("PASS");
    expect(trace).toMatchObject({ provider_result_hash: "real-provider-hash", provider_result_immutable: true, generated_input_hash: "synthetic-mutation-hash", generated_input_provenance: "SYNTHETIC_CONTROL_MUTATION" });
  });

  it("supports stable affine mapping and rejects affine evidence outside policy bounds", () => {
    const source = image();
    const affine: MappingEvidence = { model: "affine", source_to_target_normalized: [1, 0, 0.02, 0, 1, 0.01], supporting_inliers: 80, inlier_ratio: 0.9, stable: true };
    const mapped = warpSourceToTarget(source, affine);
    const attempt = new DeterministicSourceRestoreV1().attempt(input({ source, transformationReference: mapped, providerResult: mutateInside(mapped), mapping: affine }));
    expect(attempt.eligibility.checks.mapping).toBe("PASS");
    expect(attempt.mapping.target_polygon).not.toEqual(attempt.mapping.source_polygon);
    const weak = new DeterministicSourceRestoreV1().attempt(input({ mapping: { ...affine, supporting_inliers: 4, inlier_ratio: 0.2 } }));
    expect(weak.provisionalOutcome).toBe("REPAIR_BLOCKED_ALIGNMENT");
  });

  it("bounds blend harmonization and blocks insufficient photometric context", () => {
    const source = image();
    const shifted = { ...source, data: Buffer.from(source.data) };
    for (let index = 0; index < shifted.data.length; index += 1) shifted.data[index] = Math.min(255, shifted.data[index]! + 21);
    const attempt = new DeterministicSourceRestoreV1().attempt(input({ source, transformationReference: source, providerResult: shifted, initialVerification: snapshot(source, shifted) }));
    expect(attempt.blendAdjustment.every((value) => Math.abs(value) <= preservePolicy.context.maximum_blend_band_channel_adjustment_8bit)).toBe(true);
    expect(attempt.provisionalOutcome).toBe("REPAIR_BLOCKED_INSUFFICIENT_CONTEXT");
  });

  it("records outer-ring failure and maps review improvement, unchanged, and not-needed outcomes", () => {
    const engineInput = input();
    const failed = new DeterministicSourceRestoreV1().attempt(engineInput);
    const ringPixel = failed.outerRingMask.findIndex((value) => value === 1);
    expect(ringPixel).toBeGreaterThanOrEqual(0);
    failed.repaired.data[ringPixel * 3] = (failed.repaired.data[ringPixel * 3]! + 127) % 256;
    expect(completePreservationTrace(failed, { decision: "PRESERVED", measurements: measurements({ mad: 0, changed: 0, ssim: 1, edge: 0 }) }).outcome).toBe("REPAIR_FAILED");

    const improvedInput = input({ initialVerification: { decision: "CHANGED", measurements: measurements({ mad: 0.2, changed: 0.5, ssim: 0.4, edge: 0.4 }) } });
    const improved = new DeterministicSourceRestoreV1().attempt(improvedInput);
    expect(completePreservationTrace(improved, { decision: "REVIEW", measurements: measurements({ mad: 0.1, changed: 0.3, ssim: 0.6, edge: 0.2 }) }).outcome).toBe("IMPROVED_BUT_REVIEW");

    const unchangedInput = input({ initialVerification: { decision: "CHANGED", measurements: measurements({ mad: 0.2, changed: 0.5, ssim: 0.4, edge: 0.4 }) } });
    const unchanged = new DeterministicSourceRestoreV1().attempt(unchangedInput);
    expect(completePreservationTrace(unchanged, unchangedInput.initialVerification).outcome).toBe("UNCHANGED");

    const notNeededInput = input({ initialVerification: { decision: "PRESERVED", measurements: measurements({ mad: 0, changed: 0, ssim: 1, edge: 0 }) } });
    const notNeeded = new DeterministicSourceRestoreV1().attempt(notNeededInput);
    expect(completePreservationTrace(notNeeded, notNeededInput.initialVerification).outcome).toBe("NOT_NEEDED");
  });

  it("is byte-for-byte deterministic with stable identifiers and traces", () => {
    const engineInput = input();
    const engine = new DeterministicSourceRestoreV1();
    const first = engine.attempt(engineInput);
    const second = engine.attempt(engineInput);
    expect(first.repaired.data).toEqual(second.repaired.data);
    expect(first.repairId).toBe(second.repairId);
    expect(completePreservationTrace(first, snapshot(engineInput.source, first.repaired))).toEqual(completePreservationTrace(second, snapshot(engineInput.source, second.repaired)));
  });

  it("computes the transformation mask without label semantics and enforces the outer-ring thresholds", () => {
    const source = image();
    const changed = mutateInside(source);
    expect(transformationZoneMask(source, changed, 24).some((value) => value === 1)).toBe(true);
    const zero = measurements({ mad: 0, changed: 0, ssim: 1, edge: 0 });
    expect(outerRingPass(zero, input())).toBe(true);
  });

  it("keeps the engine internal, provider-free, and behind the existing secret-gated worker boundary", async () => {
    const [engineSource, preservationSource, workerSource] = await Promise.all([
      readFile(resolve("src/preserve/engine.ts"), "utf8"),
      readFile(resolve("src/product/live/preservation.ts"), "utf8"),
      readFile(resolve("api/verification-worker.py"), "utf8"),
    ]);
    expect(`${engineSource}\n${preservationSource}`).not.toMatch(/YouCamClient|YOUCAM_API_KEY|provider\.start|provider\.poll/);
    expect(preservationSource).toMatch(/providerCalls:\s*0[\s\S]*youcamUnits:\s*0/);
    expect(workerSource).toMatch(/CRON_SECRET[\s\S]*compare_digest/);
  });
});

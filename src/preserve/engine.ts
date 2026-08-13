import { createHash } from "node:crypto";
import { createRegionMask } from "../verification/regions.js";
import { measureRegion } from "../verification/metrics.js";
import type { NormalizedPoint, RawImage, RegionMeasurements } from "../verification/types.js";
import type {
  MappingEvidence,
  MappingTrace,
  PreserveAttempt,
  PreserveAttemptInput,
  PreservationTrace,
  RepairEligibility,
  RepairOutcome,
  VerificationDeltas,
  VerificationSnapshot,
} from "./types.js";
import { PRESERVE_ENGINE_VERSION } from "./types.js";

function assertImages(source: RawImage, provider: RawImage): void {
  if (source.channels !== 3 || provider.channels !== 3 || source.width !== provider.width || source.height !== provider.height) {
    throw new Error("Preserve Engine requires aligned RGB source and provider images.");
  }
  if (source.data.length !== source.width * source.height * 3 || provider.data.length !== provider.width * provider.height * 3) {
    throw new Error("Preserve Engine image buffers are malformed.");
  }
}

function count(mask: Buffer): number {
  let output = 0;
  for (const value of mask) if (value) output += 1;
  return output;
}

export function dilateMask(mask: Buffer, width: number, height: number, radius: number): Buffer {
  let current = Buffer.from(mask);
  for (let step = 0; step < radius; step += 1) {
    const next = Buffer.from(current);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!current[index]) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          const targetY = y + dy;
          if (targetY < 0 || targetY >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const targetX = x + dx;
            if (targetX >= 0 && targetX < width) next[targetY * width + targetX] = 1;
          }
        }
      }
    }
    current = next;
  }
  return current;
}

function subtractMask(outer: Buffer, inner: Buffer): Buffer {
  const output = Buffer.alloc(outer.length);
  for (let index = 0; index < output.length; index += 1) output[index] = outer[index] && !inner[index] ? 1 : 0;
  return output;
}

export function transformationZoneMask(source: RawImage, provider: RawImage, threshold: number): Buffer {
  assertImages(source, provider);
  const output = Buffer.alloc(source.width * source.height);
  for (let pixel = 0; pixel < output.length; pixel += 1) {
    const offset = pixel * 3;
    const difference = Math.max(
      Math.abs(source.data[offset]! - provider.data[offset]!),
      Math.abs(source.data[offset + 1]! - provider.data[offset + 1]!),
      Math.abs(source.data[offset + 2]! - provider.data[offset + 2]!),
    );
    if (difference > threshold) output[pixel] = 1;
  }
  return output;
}

function mapPoint(point: NormalizedPoint, matrix: MappingEvidence["source_to_target_normalized"]): NormalizedPoint {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + b * point.y + c, y: d * point.x + e * point.y + f };
}

function affineQuality(mapping: MappingEvidence, input: PreserveAttemptInput): boolean {
  if (!mapping.stable) return false;
  if (mapping.model === "identity" || mapping.model === "uniform_scale_translation") return true;
  if (mapping.supporting_inliers < input.policy.mapping.minimum_affine_supporting_inliers || mapping.inlier_ratio < input.policy.mapping.minimum_affine_inlier_ratio) return false;
  const [a, b, , d, e] = mapping.source_to_target_normalized;
  const scaleX = Math.hypot(a, d);
  const scaleY = Math.hypot(b, e);
  const shear = Math.abs(a * b + d * e) / Math.max(1e-9, scaleX * scaleY);
  return Math.abs(scaleX - 1) <= input.policy.mapping.maximum_affine_scale_change
    && Math.abs(scaleY - 1) <= input.policy.mapping.maximum_affine_scale_change
    && shear <= input.policy.mapping.maximum_affine_shear;
}

function invertAffine(matrix: MappingEvidence["source_to_target_normalized"]): MappingEvidence["source_to_target_normalized"] {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * e - b * d;
  if (Math.abs(determinant) < 1e-9) throw new Error("Preserve mapping is singular.");
  return [e / determinant, -b / determinant, (b * f - e * c) / determinant, -d / determinant, a / determinant, (d * c - a * f) / determinant];
}

function sampleBilinear(image: RawImage, normalizedX: number, normalizedY: number, output: Buffer, outputOffset: number): void {
  const x = Math.max(0, Math.min(image.width - 1, normalizedX * (image.width - 1)));
  const y = Math.max(0, Math.min(image.height - 1, normalizedY * (image.height - 1)));
  const x0 = Math.floor(x), x1 = Math.min(image.width - 1, x0 + 1);
  const y0 = Math.floor(y), y1 = Math.min(image.height - 1, y0 + 1);
  const wx = x - x0, wy = y - y0;
  for (let channel = 0; channel < 3; channel += 1) {
    const top = image.data[(y0 * image.width + x0) * 3 + channel]! * (1 - wx) + image.data[(y0 * image.width + x1) * 3 + channel]! * wx;
    const bottom = image.data[(y1 * image.width + x0) * 3 + channel]! * (1 - wx) + image.data[(y1 * image.width + x1) * 3 + channel]! * wx;
    output[outputOffset + channel] = Math.round(top * (1 - wy) + bottom * wy);
  }
}

export function warpSourceToTarget(source: RawImage, mapping: MappingEvidence): RawImage {
  const identity = mapping.source_to_target_normalized.every((value, index) => Math.abs(value - [1, 0, 0, 0, 1, 0][index]!) < 1e-12);
  if (identity) return { ...source, data: Buffer.from(source.data) };
  const inverse = invertAffine(mapping.source_to_target_normalized);
  const data = Buffer.alloc(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const targetX = (x + 0.5) / source.width;
      const targetY = (y + 0.5) / source.height;
      const sourcePoint = mapPoint({ x: targetX, y: targetY }, inverse);
      sampleBilinear(source, sourcePoint.x, sourcePoint.y, data, (y * source.width + x) * 3);
    }
  }
  return { ...source, data };
}

function contextAdjustment(mappedSource: RawImage, provider: RawImage, contextMask: Buffer): { raw: [number, number, number]; bounded: [number, number, number] } {
  const sums = [0, 0, 0];
  let pixels = 0;
  for (let pixel = 0; pixel < contextMask.length; pixel += 1) {
    if (!contextMask[pixel]) continue;
    pixels += 1;
    const offset = pixel * 3;
    for (let channel = 0; channel < 3; channel += 1) sums[channel]! += provider.data[offset + channel]! - mappedSource.data[offset + channel]!;
  }
  const raw = sums.map((value) => value / Math.max(1, pixels)) as [number, number, number];
  return { raw, bounded: [0, 0, 0] };
}

function overlap(core: Buffer, zone: Buffer): number {
  let output = 0;
  for (let index = 0; index < core.length; index += 1) if (core[index] && zone[index]) output += 1;
  return output;
}

function buildBlendAlpha(core: Buffer, width: number, height: number, radius: number): { alpha: Buffer; blendMask: Buffer } {
  const alpha = Buffer.alloc(core.length);
  for (let index = 0; index < core.length; index += 1) if (core[index]) alpha[index] = 255;
  let previous: Buffer = Buffer.from(core);
  for (let distance = 1; distance <= radius; distance += 1) {
    const expanded = dilateMask(previous, width, height, 1);
    const weight = Math.round(255 * (radius + 1 - distance) / (radius + 1));
    for (let index = 0; index < expanded.length; index += 1) if (expanded[index] && !previous[index]) alpha[index] = weight;
    previous = expanded;
  }
  return { alpha, blendMask: previous };
}

function restore(mappedSource: RawImage, provider: RawImage, core: Buffer, alpha: Buffer, adjustment: [number, number, number]): RawImage {
  const data = Buffer.from(provider.data);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    const weight = alpha[pixel]! / 255;
    if (weight === 0) continue;
    const offset = pixel * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      const sourceValue = mappedSource.data[offset + channel]! + (core[pixel] ? 0 : adjustment[channel]!);
      const boundedSource = Math.max(0, Math.min(255, sourceValue));
      data[offset + channel] = Math.round(boundedSource * weight + provider.data[offset + channel]! * (1 - weight));
    }
  }
  return { ...provider, data };
}

function accountChanges(provider: RawImage, repaired: RawImage) {
  let modified = 0;
  const total = provider.width * provider.height;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const offset = pixel * 3;
    if (provider.data[offset] !== repaired.data[offset] || provider.data[offset + 1] !== repaired.data[offset + 1] || provider.data[offset + 2] !== repaired.data[offset + 2]) modified += 1;
  }
  return { modified_pixels: modified, total_pixels: total, modified_pixel_percentage: modified / total * 100 };
}

/**
 * Applies the unchanged V1 restoration math after the independent V2 intent
 * gate has approved the footprint. The V1 visual-difference overlap remains
 * recorded as historical evidence, but is not allowed to override V2.
 */
export function applyV2ApprovedRestore(attempt: PreserveAttempt): PreserveAttempt {
  const { alpha } = buildBlendAlpha(
    attempt.coreMask,
    attempt.input.providerResult.width,
    attempt.input.providerResult.height,
    attempt.input.policy.context.blend_band_pixels,
  );
  const repaired = restore(attempt.mappedSource, attempt.input.providerResult, attempt.coreMask, alpha, attempt.blendAdjustment);
  return { ...attempt, repaired, provisionalOutcome: null, changeAccounting: accountChanges(attempt.input.providerResult, repaired) };
}

function emptyOuterMeasurements(image: RawImage, mask: Buffer): RegionMeasurements {
  return measureRegion(image, image, mask, 12, 0.1).measurements;
}

export class DeterministicSourceRestoreV1 {
  readonly version = PRESERVE_ENGINE_VERSION;

  attempt(input: PreserveAttemptInput): PreserveAttempt {
    assertImages(input.source, input.providerResult);
    assertImages(input.source, input.transformationReference);
    const targetPolygon = input.region.polygon.map((point) => mapPoint(point, input.mapping.source_to_target_normalized));
    const mapping: MappingTrace = {
      model: input.mapping.model,
      source_to_target_normalized: input.mapping.source_to_target_normalized,
      supporting_inliers: input.mapping.supporting_inliers,
      inlier_ratio: input.mapping.inlier_ratio,
      source_polygon: input.region.polygon,
      target_polygon: targetPolygon,
    };
    const targetRegion = { ...input.region, polygon: targetPolygon };
    const inBounds = targetPolygon.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
    const mappingPass = affineQuality(input.mapping, input);
    const coreMask = inBounds ? createRegionMask(targetRegion, input.providerResult.width, input.providerResult.height) : Buffer.alloc(input.providerResult.width * input.providerResult.height);
    const mappedSource = warpSourceToTarget(input.source, input.mapping);
    const blendRadius = input.policy.context.blend_band_pixels;
    const contextRadius = input.policy.context.photometric_context_ring_pixels;
    const outerRadius = input.policy.context.outer_safety_ring_pixels;
    const { alpha, blendMask } = buildBlendAlpha(coreMask, input.providerResult.width, input.providerResult.height, blendRadius);
    const contextOuter = dilateMask(coreMask, input.providerResult.width, input.providerResult.height, blendRadius + contextRadius);
    const contextMask = subtractMask(contextOuter, blendMask);
    const outerMask = subtractMask(
      dilateMask(coreMask, input.providerResult.width, input.providerResult.height, blendRadius + outerRadius),
      blendMask,
    );
    const contextPixels = count(contextMask);
    const adjustment = contextAdjustment(mappedSource, input.providerResult, contextMask);
    const maximumAdjustment = input.policy.context.maximum_blend_band_channel_adjustment_8bit;
    adjustment.bounded = adjustment.raw.map((value) => Math.max(-maximumAdjustment, Math.min(maximumAdjustment, value))) as [number, number, number];
    const zone = transformationZoneMask(mappedSource, input.transformationReference, input.policy.transformation_zone.per_pixel_max_channel_difference_8bit);
    const regionPixels = count(coreMask);
    const overlapPixels = overlap(coreMask, zone);
    const overlapRatio = overlapPixels / Math.max(1, regionPixels);
    const checks: RepairEligibility["checks"] = {
      continuity: input.continuity.localVerificationEligible && input.continuity.state === "CONSISTENT" ? "PASS" : "BLOCKED",
      mapping: mappingPass ? "PASS" : "BLOCKED",
      bounds: inBounds ? "PASS" : "BLOCKED",
      context: contextPixels >= input.policy.context.minimum_context_pixels
        && adjustment.raw.every((value) => Math.abs(value) <= input.policy.context.maximum_context_mean_channel_delta_8bit) ? "PASS" : "BLOCKED",
      transformation_overlap: overlapRatio < input.policy.transformation_zone.block_at_or_above_overlap_ratio ? "PASS" : "BLOCKED",
    };
    let outcomeIfBlocked: RepairOutcome | null = null;
    if (checks.continuity === "BLOCKED") outcomeIfBlocked = "REPAIR_BLOCKED_CONTINUITY";
    else if (checks.mapping === "BLOCKED" || checks.bounds === "BLOCKED") outcomeIfBlocked = "REPAIR_BLOCKED_ALIGNMENT";
    else if (checks.transformation_overlap === "BLOCKED") outcomeIfBlocked = "REPAIR_BLOCKED_TRANSFORM_OVERLAP";
    else if (checks.context === "BLOCKED") outcomeIfBlocked = "REPAIR_BLOCKED_INSUFFICIENT_CONTEXT";
    const eligibility: RepairEligibility = {
      eligible: outcomeIfBlocked === null,
      checks,
      overlap_pixels: overlapPixels,
      region_pixels: regionPixels,
      overlap_ratio: overlapRatio,
      overlap_threshold: input.policy.transformation_zone.block_at_or_above_overlap_ratio,
      context_pixels: contextPixels,
      raw_context_mean_channel_delta_8bit: adjustment.raw,
      outcome_if_blocked: outcomeIfBlocked,
    };
    const notNeeded = input.initialVerification.decision === "PRESERVED";
    const repaired = eligibility.eligible && !notNeeded
      ? restore(mappedSource, input.providerResult, coreMask, alpha, adjustment.bounded)
      : { ...input.providerResult, data: Buffer.from(input.providerResult.data) };
    const repairId = `preserve-${createHash("sha256").update([input.sourceHash, input.generatedInputHash, input.region.id, input.policy.version].join("\n")).digest("hex").slice(0, 24)}`;
    return {
      input,
      repairId,
      sourceHash: input.sourceHash,
      providerResultHash: input.providerResultHash,
      mapping,
      eligibility,
      repaired,
      mappedSource,
      coreMask,
      blendMask,
      outerRingMask: outerMask,
      transformationZoneMask: zone,
      blendAdjustment: adjustment.bounded,
      changeAccounting: accountChanges(input.providerResult, repaired),
      provisionalOutcome: outcomeIfBlocked ?? (notNeeded ? "NOT_NEEDED" : null),
    };
  }
}

export interface PreserveEngine {
  attempt(input: PreserveAttemptInput): PreserveAttempt;
}

function deltas(before: VerificationSnapshot, after: VerificationSnapshot): VerificationDeltas {
  return {
    mad_delta: after.measurements.mean_absolute_difference.normalized - before.measurements.mean_absolute_difference.normalized,
    changed_ratio_delta: after.measurements.changed_pixel_ratio.ratio - before.measurements.changed_pixel_ratio.ratio,
    ssim_delta: after.measurements.ssim.value - before.measurements.ssim.value,
    edge_difference_delta: after.measurements.edge_difference.ratio - before.measurements.edge_difference.ratio,
  };
}

export function outerRingPass(measurements: RegionMeasurements, input: PreserveAttemptInput): boolean {
  const policy = input.policy.outer_ring;
  return measurements.mean_absolute_difference.normalized <= policy.maximum_mean_absolute_difference
    && measurements.changed_pixel_ratio.ratio <= policy.maximum_changed_pixel_ratio
    && measurements.ssim.value >= policy.minimum_ssim
    && measurements.edge_difference.ratio <= policy.maximum_edge_difference;
}

function materiallyImproved(delta: VerificationDeltas, input: PreserveAttemptInput): boolean {
  const policy = input.policy.material_improvement;
  const noExcessiveRegression = delta.mad_delta <= policy.maximum_allowed_mad_regression
    && delta.changed_ratio_delta <= policy.maximum_allowed_changed_ratio_regression
    && delta.ssim_delta >= -policy.maximum_allowed_ssim_regression
    && delta.edge_difference_delta <= policy.maximum_allowed_edge_difference_regression;
  const improvement = -delta.mad_delta >= policy.minimum_mad_reduction
    || -delta.changed_ratio_delta >= policy.minimum_changed_ratio_reduction
    || delta.ssim_delta >= policy.minimum_ssim_increase
    || -delta.edge_difference_delta >= policy.minimum_edge_difference_reduction;
  return noExcessiveRegression && improvement;
}

export function completePreservationTrace(attempt: PreserveAttempt, finalVerification: VerificationSnapshot): PreservationTrace {
  const verificationDeltas = deltas(attempt.input.initialVerification, finalVerification);
  const outerMeasurements = measureRegion(attempt.input.providerResult, attempt.repaired, attempt.outerRingMask, 12, 0.1).measurements;
  const ringPassed = outerRingPass(outerMeasurements, attempt.input);
  let outcome = attempt.provisionalOutcome;
  if (!outcome) {
    if (!ringPassed) outcome = "REPAIR_FAILED";
    else if (attempt.input.initialVerification.decision !== "PRESERVED" && finalVerification.decision === "PRESERVED") outcome = "RESTORED";
    else if (finalVerification.decision === "REVIEW" && materiallyImproved(verificationDeltas, attempt.input)) outcome = "IMPROVED_BUT_REVIEW";
    else outcome = "UNCHANGED";
  }
  return {
    schema_version: "1.0",
    repair_id: attempt.repairId,
    session_id: attempt.input.sessionId,
    repair_implementation: PRESERVE_ENGINE_VERSION,
    source_hash: attempt.sourceHash,
    provider_result_hash: attempt.providerResultHash,
    provider_result_immutable: true,
    generated_input_hash: attempt.input.generatedInputHash,
    generated_input_provenance: attempt.input.generatedInputProvenance,
    region_id: attempt.input.region.id,
    initial_verification: attempt.input.initialVerification,
    eligibility: attempt.eligibility,
    mapping: attempt.mapping,
    repair_method: "DETERMINISTIC_SOURCE_RESTORE_DISTANCE_FEATHER",
    repair_parameters: {
      protected_core_source_weight: 1,
      blend_band_pixels: attempt.input.policy.context.blend_band_pixels,
      photometric_context_ring_pixels: attempt.input.policy.context.photometric_context_ring_pixels,
      core_photometric_adjustment_8bit: [0, 0, 0],
      blend_band_photometric_adjustment_8bit: attempt.blendAdjustment,
    },
    output_hash: createHash("sha256").update(attempt.repaired.data).digest("hex"),
    final_verification: finalVerification,
    verification_deltas: verificationDeltas,
    outer_ring_verification: { measurements: outerMeasurements, passed: ringPassed },
    full_image_change_accounting: attempt.changeAccounting,
    outcome,
    provider_calls: 0,
    youcam_units: 0,
  };
}

export function identityMapping(supportingInliers: number, inlierRatio: number): MappingEvidence {
  return { model: "identity", source_to_target_normalized: [1, 0, 0, 0, 1, 0], supporting_inliers: supportingInliers, inlier_ratio: inlierRatio, stable: true };
}

export function zeroChangeMeasurements(image: RawImage, mask: Buffer): RegionMeasurements {
  return emptyOuterMeasurements(image, mask);
}

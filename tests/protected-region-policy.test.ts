import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, validatePolicy } from "../src/verification/policy.js";
import type { RegionMeasurements } from "../src/verification/types.js";

const policy = validatePolicy(JSON.parse(readFileSync("config/preservation-policy.json", "utf8")) as unknown);

function measurements(mad: number, ratio: number, ssim: number, edge: number): RegionMeasurements {
  return {
    mean_absolute_difference: { normalized: mad, raw_absolute_channel_sum: 0, compared_channels: 1, range: "0..1" },
    changed_pixel_ratio: { tolerance_8bit: 12, changed_pixels: 0, total_region_pixels: 1, ratio, per_pixel_rule: "maximum RGB channel difference exceeds tolerance" },
    ssim: { value: ssim, range: "-1..1", implementation: "global grayscale SSIM formula", k1: 0.01, k2: 0.03, dynamic_range: 255 },
    edge_difference: { sobel_threshold_normalized: 0.1, original_edge_pixels: 0, generated_edge_pixels: 0, mismatched_edge_pixels: 0, total_region_pixels: 1, ratio: edge, range: "0..1" },
  };
}

describe("EXPERIMENTAL_POLICY_V1 boundaries", () => {
  it("preserves values strictly within all thresholds", () => {
    expect(evaluatePolicy(measurements(0, 0, 1, 0), policy).decision).toBe("PRESERVED");
  });

  it("routes one warning or one change signal to review", () => {
    expect(evaluatePolicy(measurements(0.035, 0, 1, 0), policy).decision).toBe("REVIEW");
    expect(evaluatePolicy(measurements(0.1, 0, 1, 0), policy).decision).toBe("REVIEW");
  });

  it("requires multiple independent change signals for changed", () => {
    const result = evaluatePolicy(measurements(0.1, 0.4, 1, 0), policy);
    expect(result.change_signal_count).toBe(2);
    expect(result.decision).toBe("CHANGED");
  });
});

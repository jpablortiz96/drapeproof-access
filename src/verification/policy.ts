import { readFile } from "node:fs/promises";
import type {
  PolicyEvaluation,
  PreservationPolicy,
  RegionMeasurements,
  SignalLevel,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validAscendingThreshold(value: unknown): value is { warning_at_or_above: number; change_at_or_above: number } {
  return isRecord(value)
    && typeof value.warning_at_or_above === "number"
    && typeof value.change_at_or_above === "number"
    && value.warning_at_or_above >= 0
    && value.change_at_or_above <= 1
    && value.warning_at_or_above < value.change_at_or_above;
}

function validDescendingThreshold(value: unknown): value is { warning_at_or_below: number; change_at_or_below: number } {
  return isRecord(value)
    && typeof value.warning_at_or_below === "number"
    && typeof value.change_at_or_below === "number"
    && value.change_at_or_below >= -1
    && value.warning_at_or_below <= 1
    && value.change_at_or_below < value.warning_at_or_below;
}

export function validatePolicy(value: unknown): PreservationPolicy {
  if (!isRecord(value) || value.name !== "EXPERIMENTAL_POLICY_V1" || value.validated !== false) {
    throw new Error("Policy must be named EXPERIMENTAL_POLICY_V1 and explicitly set validated to false.");
  }
  if (typeof value.version !== "string" || typeof value.description !== "string") throw new Error("Policy version and description are required.");
  if (!Number.isInteger(value.pixel_tolerance_8bit) || (value.pixel_tolerance_8bit as number) < 0 || (value.pixel_tolerance_8bit as number) > 255) {
    throw new Error("Policy pixel_tolerance_8bit must be an integer from 0 through 255.");
  }
  if (typeof value.sobel_edge_threshold_normalized !== "number" || value.sobel_edge_threshold_normalized < 0 || value.sobel_edge_threshold_normalized > 1) {
    throw new Error("Policy Sobel threshold must be from 0 through 1.");
  }
  if (!isRecord(value.thresholds)
    || !validAscendingThreshold(value.thresholds.mean_absolute_difference)
    || !validAscendingThreshold(value.thresholds.changed_pixel_ratio)
    || !validDescendingThreshold(value.thresholds.ssim)
    || !validAscendingThreshold(value.thresholds.edge_difference)) {
    throw new Error("Policy thresholds are malformed or out of order.");
  }
  if (!isRecord(value.decision_logic)
    || !Number.isInteger(value.decision_logic.changed_minimum_change_signals)
    || (value.decision_logic.changed_minimum_change_signals as number) < 1
    || typeof value.decision_logic.review_on_any_change_signal !== "boolean"
    || typeof value.decision_logic.review_on_any_warning_signal !== "boolean") {
    throw new Error("Policy decision logic is malformed.");
  }
  return value as unknown as PreservationPolicy;
}

export async function readPolicy(path: string): Promise<PreservationPolicy> {
  return validatePolicy(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function ascendingLevel(value: number, warning: number, change: number): SignalLevel {
  if (value >= change) return "change";
  if (value >= warning) return "warning";
  return "within_threshold";
}

function descendingLevel(value: number, warning: number, change: number): SignalLevel {
  if (value <= change) return "change";
  if (value <= warning) return "warning";
  return "within_threshold";
}

export function evaluatePolicy(measurements: RegionMeasurements, policy: PreservationPolicy): PolicyEvaluation {
  const signalLevels: PolicyEvaluation["signal_levels"] = {
    mean_absolute_difference: ascendingLevel(
      measurements.mean_absolute_difference.normalized,
      policy.thresholds.mean_absolute_difference.warning_at_or_above,
      policy.thresholds.mean_absolute_difference.change_at_or_above,
    ),
    changed_pixel_ratio: ascendingLevel(
      measurements.changed_pixel_ratio.ratio,
      policy.thresholds.changed_pixel_ratio.warning_at_or_above,
      policy.thresholds.changed_pixel_ratio.change_at_or_above,
    ),
    ssim: descendingLevel(
      measurements.ssim.value,
      policy.thresholds.ssim.warning_at_or_below,
      policy.thresholds.ssim.change_at_or_below,
    ),
    edge_difference: ascendingLevel(
      measurements.edge_difference.ratio,
      policy.thresholds.edge_difference.warning_at_or_above,
      policy.thresholds.edge_difference.change_at_or_above,
    ),
  };
  const levels = Object.values(signalLevels);
  const warningCount = levels.filter((level) => level === "warning").length;
  const changeCount = levels.filter((level) => level === "change").length;
  let decision: PolicyEvaluation["decision"] = "PRESERVED";
  if (changeCount >= policy.decision_logic.changed_minimum_change_signals) decision = "CHANGED";
  else if ((changeCount > 0 && policy.decision_logic.review_on_any_change_signal)
    || (warningCount > 0 && policy.decision_logic.review_on_any_warning_signal)) decision = "REVIEW";
  return {
    name: policy.name,
    version: policy.version,
    validated: false,
    signal_levels: signalLevels,
    warning_signal_count: warningCount,
    change_signal_count: changeCount,
    decision,
  };
}

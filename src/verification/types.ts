export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface ProtectedRegion {
  id: string;
  label: string;
  polygon: NormalizedPoint[];
}

export interface RegionDefinitionFile {
  schema_version: "1.0";
  coordinate_space: "normalized";
  source_run_id?: string;
  regions: ProtectedRegion[];
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3;
}

export interface MeanAbsoluteDifferenceMeasurement {
  normalized: number;
  raw_absolute_channel_sum: number;
  compared_channels: number;
  range: "0..1";
}

export interface ChangedPixelRatioMeasurement {
  tolerance_8bit: number;
  changed_pixels: number;
  total_region_pixels: number;
  ratio: number;
  per_pixel_rule: "maximum RGB channel difference exceeds tolerance";
}

export interface SsimMeasurement {
  value: number;
  range: "-1..1";
  implementation: "global grayscale SSIM formula";
  k1: 0.01;
  k2: 0.03;
  dynamic_range: 255;
}

export interface EdgeDifferenceMeasurement {
  sobel_threshold_normalized: number;
  original_edge_pixels: number;
  generated_edge_pixels: number;
  mismatched_edge_pixels: number;
  total_region_pixels: number;
  ratio: number;
  range: "0..1";
}

export interface RegionMeasurements {
  mean_absolute_difference: MeanAbsoluteDifferenceMeasurement;
  changed_pixel_ratio: ChangedPixelRatioMeasurement;
  ssim: SsimMeasurement;
  edge_difference: EdgeDifferenceMeasurement;
}

export interface MetricArtifacts {
  absoluteDifference: Buffer;
  heatmap: Buffer;
  originalEdges: Buffer;
  generatedEdges: Buffer;
}

export interface MeasurementResult {
  measurements: RegionMeasurements;
  artifacts: MetricArtifacts;
}

export type PolicyDecision = "PRESERVED" | "REVIEW" | "CHANGED";
export type SignalLevel = "within_threshold" | "warning" | "change";

export interface PreservationPolicy {
  name: "EXPERIMENTAL_POLICY_V1";
  version: string;
  validated: false;
  description: string;
  pixel_tolerance_8bit: number;
  sobel_edge_threshold_normalized: number;
  thresholds: {
    mean_absolute_difference: { warning_at_or_above: number; change_at_or_above: number };
    changed_pixel_ratio: { warning_at_or_above: number; change_at_or_above: number };
    ssim: { warning_at_or_below: number; change_at_or_below: number };
    edge_difference: { warning_at_or_above: number; change_at_or_above: number };
  };
  decision_logic: {
    changed_minimum_change_signals: number;
    review_on_any_change_signal: boolean;
    review_on_any_warning_signal: boolean;
  };
}

export interface PolicyEvaluation {
  name: "EXPERIMENTAL_POLICY_V1";
  version: string;
  validated: false;
  signal_levels: Record<keyof RegionMeasurements, SignalLevel>;
  warning_signal_count: number;
  change_signal_count: number;
  decision: PolicyDecision;
}

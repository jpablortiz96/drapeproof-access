import type { SignalStatus } from "./frame.js";

export const CRITICAL_POSE_LANDMARKS = [
  "left-shoulder", "right-shoulder", "left-elbow", "right-elbow", "left-wrist", "right-wrist",
  "left-hip", "right-hip", "left-knee", "right-knee", "left-ankle", "right-ankle",
] as const;

const LOWER_BODY_LANDMARKS = ["left-hip", "right-hip", "left-knee", "right-knee", "left-ankle", "right-ankle"] as const;

export interface PoseLandmark {
  index: number;
  name: string;
  x: number;
  y: number;
  z: number;
  visibility: number | null;
  presence: number | null;
}

export interface RawPoseOutput {
  schema_version: "1.0";
  implementation: string;
  dependency_version: string;
  model: Record<string, unknown>;
  inference: Record<string, unknown>;
  input: { path: string; sha256: string; width: number; height: number };
  landmark_schema: string;
  poses_detected: number;
  landmarks: PoseLandmark[];
}

export interface PosePolicy {
  landmark_visibility_minimum: number;
  landmark_presence_minimum: number;
  minimum_common_critical_landmarks: number;
  critical_landmark_loss_fail_at_or_above: number;
  lower_body_landmark_loss_fail_at_or_above: number;
  mean_body_coordinate_delta_review_at_or_above: number;
  mean_body_coordinate_delta_fail_at_or_above: number;
  maximum_angle_delta_degrees_review_at_or_above: number;
  maximum_angle_delta_degrees_fail_at_or_above: number;
  pose_bbox_relative_size_delta_review_at_or_above: number;
  pose_bbox_relative_size_delta_fail_at_or_above: number;
}

interface Point { x: number; y: number }

export interface PoseEvidence extends RawPoseOutput {
  derived: {
    available_landmark_count: number;
    available_critical_landmark_count: number;
    available_critical_landmarks: string[];
    unavailable_critical_landmarks: string[];
    pose_bounding_box: { min_x: number; min_y: number; max_x: number; max_y: number; width: number; height: number; center_x: number; center_y: number } | null;
    angles_degrees: { left_knee: number | null; right_knee: number | null; left_hip: number | null; right_hip: number | null };
    torso_inclination_degrees: number | null;
    normalized_displacements: { hip_to_knee: number | null; knee_to_ankle: number | null };
    body_centric_normalization: {
      origin: Point | null;
      torso_scale: number | null;
      rotation_degrees: number | null;
      coordinates: Record<string, Point>;
    };
  };
}

export interface PoseComparison {
  status: SignalStatus;
  reason_codes: Array<"POSE_LANDMARK_LOSS" | "POSE_GEOMETRY_SHIFT" | "BODY_FRAMING_SHIFT">;
  landmark_availability: {
    source_available_critical: number;
    generated_available_critical: number;
    common_available_critical: number;
    lost_critical_landmarks: string[];
    gained_critical_landmarks: string[];
    lost_lower_body_landmarks: string[];
  };
  angle_deltas_degrees: Record<string, number | null>;
  normalized_displacement_deltas: { hip_to_knee: number | null; knee_to_ankle: number | null };
  body_centric_coordinate_deltas: Record<string, number>;
  mean_body_centric_coordinate_delta: number | null;
  maximum_body_centric_coordinate_delta: number | null;
  pose_bbox_relative_size_delta: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid pose field: ${label}.`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNumber(value, label);
}

export function parsePoseOutput(value: unknown): RawPoseOutput {
  if (!isRecord(value) || value.schema_version !== "1.0" || !Array.isArray(value.landmarks) || !isRecord(value.input)) {
    throw new Error("Malformed pose worker output.");
  }
  const landmarks = value.landmarks.map((candidate, index): PoseLandmark => {
    if (!isRecord(candidate) || typeof candidate.name !== "string") throw new Error(`Malformed pose landmark ${index}.`);
    return {
      index: finiteNumber(candidate.index, `landmarks[${index}].index`),
      name: candidate.name,
      x: finiteNumber(candidate.x, `landmarks[${index}].x`),
      y: finiteNumber(candidate.y, `landmarks[${index}].y`),
      z: finiteNumber(candidate.z, `landmarks[${index}].z`),
      visibility: nullableNumber(candidate.visibility, `landmarks[${index}].visibility`),
      presence: nullableNumber(candidate.presence, `landmarks[${index}].presence`),
    };
  });
  const input = value.input;
  if (typeof input.path !== "string" || typeof input.sha256 !== "string") throw new Error("Malformed pose input metadata.");
  return {
    schema_version: "1.0",
    implementation: String(value.implementation),
    dependency_version: String(value.dependency_version),
    model: isRecord(value.model) ? value.model : {},
    inference: isRecord(value.inference) ? value.inference : {},
    input: { path: input.path, sha256: input.sha256, width: finiteNumber(input.width, "input.width"), height: finiteNumber(input.height, "input.height") },
    landmark_schema: String(value.landmark_schema),
    poses_detected: finiteNumber(value.poses_detected, "poses_detected"),
    landmarks,
  };
}

function isAvailable(landmark: PoseLandmark | undefined, policy: PosePolicy): landmark is PoseLandmark {
  return Boolean(landmark)
    && (landmark!.visibility ?? 0) >= policy.landmark_visibility_minimum
    && (landmark!.presence ?? 0) >= policy.landmark_presence_minimum;
}

function averagePoint(first: PoseLandmark, second: PoseLandmark): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function angleDegrees(first: Point, vertex: Point, third: Point): number | null {
  const a = { x: first.x - vertex.x, y: first.y - vertex.y };
  const b = { x: third.x - vertex.x, y: third.y - vertex.y };
  const denominator = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
  if (denominator <= 1e-12) return null;
  const cosine = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / denominator));
  return Math.acos(cosine) * 180 / Math.PI;
}

function jointAngle(map: Map<string, PoseLandmark>, policy: PosePolicy, first: string, vertex: string, third: string): number | null {
  const a = map.get(first), b = map.get(vertex), c = map.get(third);
  return isAvailable(a, policy) && isAvailable(b, policy) && isAvailable(c, policy) ? angleDegrees(a, b, c) : null;
}

export function bodyCentricNormalize(landmarks: Map<string, PoseLandmark>, policy: PosePolicy): PoseEvidence["derived"]["body_centric_normalization"] {
  const leftShoulder = landmarks.get("left-shoulder"), rightShoulder = landmarks.get("right-shoulder");
  const leftHip = landmarks.get("left-hip"), rightHip = landmarks.get("right-hip");
  if (![leftShoulder, rightShoulder, leftHip, rightHip].every((item) => isAvailable(item, policy))) {
    return { origin: null, torso_scale: null, rotation_degrees: null, coordinates: {} };
  }
  const shoulderMid = averagePoint(leftShoulder!, rightShoulder!);
  const hipMid = averagePoint(leftHip!, rightHip!);
  const torsoScale = distance(shoulderMid, hipMid);
  if (torsoScale <= 1e-12) return { origin: hipMid, torso_scale: null, rotation_degrees: null, coordinates: {} };
  const currentAngle = Math.atan2(shoulderMid.y - hipMid.y, shoulderMid.x - hipMid.x);
  const rotation = -Math.PI / 2 - currentAngle;
  const cosine = Math.cos(rotation), sine = Math.sin(rotation);
  const coordinates: Record<string, Point> = {};
  for (const name of CRITICAL_POSE_LANDMARKS) {
    const item = landmarks.get(name);
    if (!isAvailable(item, policy)) continue;
    const x = item.x - hipMid.x, y = item.y - hipMid.y;
    coordinates[name] = { x: (x * cosine - y * sine) / torsoScale, y: (x * sine + y * cosine) / torsoScale };
  }
  return { origin: hipMid, torso_scale: torsoScale, rotation_degrees: rotation * 180 / Math.PI, coordinates };
}

export function buildPoseEvidence(raw: RawPoseOutput, policy: PosePolicy): PoseEvidence {
  const map = new Map(raw.landmarks.map((landmark) => [landmark.name, landmark]));
  const available = raw.landmarks.filter((landmark) => isAvailable(landmark, policy));
  const availableCritical = CRITICAL_POSE_LANDMARKS.filter((name) => isAvailable(map.get(name), policy));
  const bbox = available.length === 0 ? null : (() => {
    const minX = Math.min(...available.map((item) => item.x)), minY = Math.min(...available.map((item) => item.y));
    const maxX = Math.max(...available.map((item) => item.x)), maxY = Math.max(...available.map((item) => item.y));
    return { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY, width: maxX - minX, height: maxY - minY, center_x: (minX + maxX) / 2, center_y: (minY + maxY) / 2 };
  })();
  const leftShoulder = map.get("left-shoulder"), rightShoulder = map.get("right-shoulder");
  const leftHip = map.get("left-hip"), rightHip = map.get("right-hip");
  let torsoInclination: number | null = null;
  let torsoScale: number | null = null;
  if ([leftShoulder, rightShoulder, leftHip, rightHip].every((item) => isAvailable(item, policy))) {
    const shoulderMid = averagePoint(leftShoulder!, rightShoulder!);
    const hipMid = averagePoint(leftHip!, rightHip!);
    torsoInclination = Math.atan2(shoulderMid.x - hipMid.x, -(shoulderMid.y - hipMid.y)) * 180 / Math.PI;
    torsoScale = distance(shoulderMid, hipMid);
  }
  const normalizedSegment = (names: Array<[string, string]>): number | null => {
    if (!torsoScale || torsoScale <= 1e-12) return null;
    const values = names.flatMap(([first, second]) => {
      const a = map.get(first), b = map.get(second);
      return isAvailable(a, policy) && isAvailable(b, policy) ? [distance(a, b) / torsoScale!] : [];
    });
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return {
    ...raw,
    derived: {
      available_landmark_count: available.length,
      available_critical_landmark_count: availableCritical.length,
      available_critical_landmarks: [...availableCritical],
      unavailable_critical_landmarks: CRITICAL_POSE_LANDMARKS.filter((name) => !availableCritical.includes(name)),
      pose_bounding_box: bbox,
      angles_degrees: {
        left_knee: jointAngle(map, policy, "left-hip", "left-knee", "left-ankle"),
        right_knee: jointAngle(map, policy, "right-hip", "right-knee", "right-ankle"),
        left_hip: jointAngle(map, policy, "left-shoulder", "left-hip", "left-knee"),
        right_hip: jointAngle(map, policy, "right-shoulder", "right-hip", "right-knee"),
      },
      torso_inclination_degrees: torsoInclination,
      normalized_displacements: {
        hip_to_knee: normalizedSegment([["left-hip", "left-knee"], ["right-hip", "right-knee"]]),
        knee_to_ankle: normalizedSegment([["left-knee", "left-ankle"], ["right-knee", "right-ankle"]]),
      },
      body_centric_normalization: bodyCentricNormalize(map, policy),
    },
  };
}

function nullableDelta(first: number | null, second: number | null): number | null {
  return first === null || second === null ? null : Math.abs(first - second);
}

function maximum(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length ? Math.max(...numbers) : null;
}

export function comparePoseEvidence(source: PoseEvidence, generated: PoseEvidence, policy: PosePolicy): PoseComparison {
  const sourceAvailable = new Set(source.derived.available_critical_landmarks);
  const generatedAvailable = new Set(generated.derived.available_critical_landmarks);
  const lost = [...sourceAvailable].filter((name) => !generatedAvailable.has(name));
  const gained = [...generatedAvailable].filter((name) => !sourceAvailable.has(name));
  const common = [...sourceAvailable].filter((name) => generatedAvailable.has(name));
  const coordinateDeltas: Record<string, number> = {};
  for (const name of common) {
    const first = source.derived.body_centric_normalization.coordinates[name];
    const second = generated.derived.body_centric_normalization.coordinates[name];
    if (first && second) coordinateDeltas[name] = distance(first, second);
  }
  const coordinateValues = Object.values(coordinateDeltas);
  const meanCoordinateDelta = coordinateValues.length ? coordinateValues.reduce((sum, value) => sum + value, 0) / coordinateValues.length : null;
  const maxCoordinateDelta = coordinateValues.length ? Math.max(...coordinateValues) : null;
  const angleDeltas: Record<string, number | null> = {
    left_knee: nullableDelta(source.derived.angles_degrees.left_knee, generated.derived.angles_degrees.left_knee),
    right_knee: nullableDelta(source.derived.angles_degrees.right_knee, generated.derived.angles_degrees.right_knee),
    left_hip: nullableDelta(source.derived.angles_degrees.left_hip, generated.derived.angles_degrees.left_hip),
    right_hip: nullableDelta(source.derived.angles_degrees.right_hip, generated.derived.angles_degrees.right_hip),
    torso_inclination: nullableDelta(source.derived.torso_inclination_degrees, generated.derived.torso_inclination_degrees),
  };
  const maxAngleDelta = maximum(Object.values(angleDeltas));
  const sourceBox = source.derived.pose_bounding_box, generatedBox = generated.derived.pose_bounding_box;
  const bboxDelta = sourceBox && generatedBox
    ? Math.max(Math.abs(sourceBox.width - generatedBox.width) / Math.max(sourceBox.width, 1e-12), Math.abs(sourceBox.height - generatedBox.height) / Math.max(sourceBox.height, 1e-12))
    : null;
  const lostLower = lost.filter((name) => (LOWER_BODY_LANDMARKS as readonly string[]).includes(name));
  const failLoss = source.poses_detected === 0 || generated.poses_detected === 0 || common.length < policy.minimum_common_critical_landmarks
    || lost.length >= policy.critical_landmark_loss_fail_at_or_above || lostLower.length >= policy.lower_body_landmark_loss_fail_at_or_above;
  const failGeometry = (meanCoordinateDelta !== null && meanCoordinateDelta >= policy.mean_body_coordinate_delta_fail_at_or_above)
    || (maxAngleDelta !== null && maxAngleDelta >= policy.maximum_angle_delta_degrees_fail_at_or_above);
  const failFraming = bboxDelta === null || bboxDelta >= policy.pose_bbox_relative_size_delta_fail_at_or_above;
  const reviewGeometry = (meanCoordinateDelta !== null && meanCoordinateDelta >= policy.mean_body_coordinate_delta_review_at_or_above)
    || (maxAngleDelta !== null && maxAngleDelta >= policy.maximum_angle_delta_degrees_review_at_or_above);
  const reviewFraming = bboxDelta !== null && bboxDelta >= policy.pose_bbox_relative_size_delta_review_at_or_above;
  const reasonCodes: PoseComparison["reason_codes"] = [];
  if (failLoss) reasonCodes.push("POSE_LANDMARK_LOSS");
  if (failGeometry || reviewGeometry) reasonCodes.push("POSE_GEOMETRY_SHIFT");
  if (failFraming || reviewFraming) reasonCodes.push("BODY_FRAMING_SHIFT");
  const status: SignalStatus = failLoss || failGeometry || failFraming ? "FAIL" : reviewGeometry || reviewFraming ? "REVIEW" : "PASS";
  return {
    status,
    reason_codes: reasonCodes,
    landmark_availability: {
      source_available_critical: sourceAvailable.size,
      generated_available_critical: generatedAvailable.size,
      common_available_critical: common.length,
      lost_critical_landmarks: lost,
      gained_critical_landmarks: gained,
      lost_lower_body_landmarks: lostLower,
    },
    angle_deltas_degrees: angleDeltas,
    normalized_displacement_deltas: {
      hip_to_knee: nullableDelta(source.derived.normalized_displacements.hip_to_knee, generated.derived.normalized_displacements.hip_to_knee),
      knee_to_ankle: nullableDelta(source.derived.normalized_displacements.knee_to_ankle, generated.derived.normalized_displacements.knee_to_ankle),
    },
    body_centric_coordinate_deltas: coordinateDeltas,
    mean_body_centric_coordinate_delta: meanCoordinateDelta,
    maximum_body_centric_coordinate_delta: maxCoordinateDelta,
    pose_bbox_relative_size_delta: bboxDelta,
  };
}

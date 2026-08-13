import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import type { ProtectedRegion } from "../../verification/types.js";
import { sha256File } from "../../hash.js";
import { runFeatureWorker, runPoseWorker, runRemoteVerificationWorkers, type VerificationWorkerResult } from "../../continuity/cv.js";
import { evaluateFeatureMatches } from "../../continuity/features.js";
import { evaluateFrameGeometry } from "../../continuity/frame.js";
import { evaluateRegionMappability } from "../../continuity/mappability.js";
import { POSE_MODEL_PATH, POSE_MODEL_SHA256 } from "../../continuity/model.js";
import { evaluateContinuity, readContinuityPolicy } from "../../continuity/policy.js";
import { buildPoseEvidence, comparePoseEvidence } from "../../continuity/pose.js";
import { repositoryRoot } from "./paths.js";
import type { SessionContinuityResult } from "./types.js";
import { VerificationRuntimeError } from "./verification-errors.js";
import { withVerificationWorkspace } from "./verification-workspace.js";

async function dimensions(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable for continuity analysis.");
  const swapped = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return { width: swapped ? metadata.height : metadata.width, height: swapped ? metadata.width : metadata.height };
}

export async function assertVerificationAssets(): Promise<{ modelSha256: string; policyName: string; workerScriptPresent: true }> {
  const root = repositoryRoot();
  const modelSha256 = await sha256File(POSE_MODEL_PATH).catch((error) => {
    throw new VerificationRuntimeError("VERIFIER_ASSET_MISSING", "The bundled pose model is missing.", { cause: error });
  });
  if (modelSha256 !== POSE_MODEL_SHA256) throw new VerificationRuntimeError("VERIFIER_ASSET_MISSING", "The bundled pose model hash is invalid.");
  const policy = await readContinuityPolicy(resolve(root, "config/continuity-policy.json")).catch((error) => {
    throw new VerificationRuntimeError("VERIFIER_ASSET_MISSING", "The bundled continuity policy is missing or invalid.", { cause: error });
  });
  await access(resolve(root, "scripts/continuity_cv.py")).catch((error) => {
    throw new VerificationRuntimeError("VERIFIER_ASSET_MISSING", "The bundled verification worker script is missing.", { cause: error });
  });
  return { modelSha256, policyName: policy.name, workerScriptPresent: true };
}

async function localWorkers(sourceBytes: Uint8Array, resultBytes: Uint8Array, outputRoot: string): Promise<VerificationWorkerResult> {
  await assertVerificationAssets();
  return withVerificationWorkspace(async (workspace) => {
    const sourcePath = resolve(workspace, "source-image");
    const resultPath = resolve(workspace, "result-image");
    await Promise.all([writeFile(sourcePath, sourceBytes), writeFile(resultPath, resultBytes), mkdir(outputRoot, { recursive: true })]);
    const [sourcePose, resultPose, features] = await Promise.all([
      runPoseWorker({ imagePath: sourcePath, modelPath: POSE_MODEL_PATH, visualPath: resolve(outputRoot, "pose-source.png") }),
      runPoseWorker({ imagePath: resultPath, modelPath: POSE_MODEL_PATH, visualPath: resolve(outputRoot, "pose-result.png") }),
      runFeatureWorker({ sourcePath, generatedPath: resultPath, matchesVisualPath: resolve(outputRoot, "feature-matches.png"), inliersVisualPath: resolve(outputRoot, "feature-inliers.png") }),
    ]);
    return { sourcePose, resultPose, features };
  });
}

export async function runLiveContinuityFromBytes(options: {
  sourceBytes: Uint8Array;
  resultBytes: Uint8Array;
  regions: ProtectedRegion[];
  outputRoot: string;
  env?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
}): Promise<SessionContinuityResult> {
  if (!options.sourceBytes.byteLength || !options.resultBytes.byteLength) throw new VerificationRuntimeError("VERIFIER_INPUT_UNAVAILABLE", "Continuity input bytes are unavailable.");
  const root = repositoryRoot();
  const policy = await readContinuityPolicy(resolve(root, "config/continuity-policy.json")).catch((error) => {
    throw new VerificationRuntimeError("VERIFIER_ASSET_MISSING", "The bundled continuity policy is missing or invalid.", { cause: error });
  });
  await mkdir(options.outputRoot, { recursive: true });
  const env = options.env ?? process.env;
  const remote = env.VERCEL === "1" || Boolean(env.DRAPEPROOF_VERIFICATION_WORKER_URL?.trim());
  const { sourcePose: sourceRaw, resultPose: resultRaw, features } = remote
    ? await runRemoteVerificationWorkers({ sourceBytes: options.sourceBytes, resultBytes: options.resultBytes, outputRoot: options.outputRoot, env, ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}) })
    : await localWorkers(options.sourceBytes, options.resultBytes, options.outputRoot);
  const [sourceDimensions, resultDimensions] = await Promise.all([dimensions(options.sourceBytes), dimensions(options.resultBytes)]);
  const sourcePose = buildPoseEvidence(sourceRaw, policy.pose_geometry);
  const resultPose = buildPoseEvidence(resultRaw, policy.pose_geometry);
  const pose = comparePoseEvidence(sourcePose, resultPose, policy.pose_geometry);
  const frame = evaluateFrameGeometry(sourceDimensions, resultDimensions, policy.frame_geometry.uniform_alignment_tolerance);
  const featureEvaluation = evaluateFeatureMatches(features, policy.feature_correspondence);
  const mappability = evaluateRegionMappability({ regions: options.regions, frame, featureMatches: features, featureEvaluation, generatedDimensions: resultDimensions });
  const decision = evaluateContinuity({ frame, pose, features: featureEvaluation, mappability });
  const state = decision.gate === "CONTINUITY_PASS" ? "CONSISTENT" : decision.gate === "CONTINUITY_REVIEW" ? "NEEDS_REVIEW" : "CHANGED_TOO_MUCH";
  return {
    state,
    localVerificationEligible: decision.local_verification_eligibility === "ELIGIBLE",
    reasonCodes: decision.reason_codes,
    signals: [
      { key: "frame", status: frame.status, reasonCodes: frame.reason_codes, raw: frame as unknown as Record<string, unknown> },
      { key: "pose", status: pose.status, reasonCodes: pose.reason_codes, raw: {
        ...pose,
        preservation_pose: {
          implementation: sourceRaw.implementation,
          model: { name: String(sourceRaw.model.name ?? "Pose landmarker"), sha256: String(sourceRaw.model.sha256 ?? "") },
          poses_detected: sourceRaw.poses_detected,
          landmarks: sourceRaw.landmarks.map((item) => ({
            index: item.index, name: item.name, x: item.x, y: item.y,
            visibility: item.visibility ?? 0, presence: item.presence ?? 0,
          })),
        },
      } as unknown as Record<string, unknown> },
      { key: "features", status: featureEvaluation.status, reasonCodes: featureEvaluation.reason_codes, raw: { ...featureEvaluation, retained_matches: features.retained_matches, geometric_inliers: features.geometric_inliers, inlier_ratio: features.inlier_ratio } },
      { key: "regions", status: mappability.status, reasonCodes: mappability.reason_codes, raw: mappability as unknown as Record<string, unknown> },
    ],
  };
}

export async function runLiveContinuity(options: {
  sourcePath: string;
  resultPath: string;
  regions: ProtectedRegion[];
  outputRoot: string;
}): Promise<SessionContinuityResult> {
  const [sourceBytes, resultBytes] = await Promise.all([readFile(options.sourcePath), readFile(options.resultPath)]);
  return runLiveContinuityFromBytes({ sourceBytes, resultBytes, regions: options.regions, outputRoot: options.outputRoot });
}

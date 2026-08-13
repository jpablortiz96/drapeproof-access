import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { measureRegion } from "../../verification/metrics.js";
import { evaluatePolicy, readPolicy } from "../../verification/policy.js";
import { createRegionMask } from "../../verification/regions.js";
import type { RawImage } from "../../verification/types.js";
import { applyV2ApprovedRestore, completePreservationTrace, DeterministicSourceRestoreV1, identityMapping } from "../../preserve/engine.js";
import { writePreserveAttemptArtifacts } from "../../preserve/artifacts.js";
import { readPreservePolicy } from "../../preserve/policy.js";
import type { PreserveAttempt, PreservationTrace, VerificationSnapshot } from "../../preserve/types.js";
import {
  evaluateIntentAwareEligibility,
  readPreservePolicyV2,
  UpperBodyPoseIntentZoneV1,
  type IntentAwareEvaluation,
  type PoseEvidence,
} from "../../preserve/v2-intent.js";
import { withPreserveWorkspace } from "../../preserve/workspace.js";
import { renderPassportPng } from "./passport.js";
import { repositoryRoot } from "./paths.js";
import type { SessionRepository } from "./repository.js";
import type {
  RepairEligibilityState,
  RepairState,
  SessionAsset,
  SessionPreservationAttempt,
  SessionProtectedRegionResult,
  TryOnSession,
} from "./types.js";

export class PreservationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PreservationError"; }
}

interface PreparedRegion {
  attempt: PreserveAttempt;
  intent: IntentAwareEvaluation;
  eligibility: RepairEligibilityState;
}

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function rawImage(bytes: Uint8Array, width: number, height: number): Promise<RawImage> {
  const result = await sharp(bytes).rotate().flatten({ background: "white" }).toColourspace("srgb").removeAlpha()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer({ resolveWithObject: true });
  if (result.info.channels !== 3) throw new PreservationError("PRESERVE_INPUT_INVALID", "The image could not be prepared for preservation.");
  return { data: result.data, width: result.info.width, height: result.info.height, channels: 3 };
}

function poseEvidence(session: TryOnSession): PoseEvidence | null {
  const raw = session.continuity.signals.find((signal) => signal.key === "pose")?.raw.preservation_pose;
  if (!raw || typeof raw !== "object") return null;
  const pose = raw as PoseEvidence;
  return Array.isArray(pose.landmarks) ? pose : null;
}

function mapping(session: TryOnSession) {
  const feature = session.continuity.signals.find((signal) => signal.key === "features");
  const regions = session.continuity.signals.find((signal) => signal.key === "regions");
  const inliers = Number(feature?.raw.geometric_inliers ?? 0);
  const ratio = Number(feature?.raw.inlier_ratio ?? 0);
  return { ...identityMapping(Number.isFinite(inliers) ? inliers : 0, Number.isFinite(ratio) ? ratio : 0), stable: regions?.status === "PASS" };
}

function eligibilityState(value: IntentAwareEvaluation["evidence"]): RepairEligibilityState {
  if (value.decision === "ELIGIBLE") return "ELIGIBLE";
  if (value.decision_reason === "REPAIR_BLOCKED_CONTINUITY") return "BLOCKED_CONTINUITY";
  if (value.decision_reason === "REPAIR_BLOCKED_ALIGNMENT") return "BLOCKED_ALIGNMENT";
  if (value.decision_reason === "REPAIR_BLOCKED_TRANSFORM_PROXIMITY") return "BLOCKED_TRANSFORM_PROXIMITY";
  if (value.decision_reason === "REPAIR_BLOCKED_INSUFFICIENT_CONTEXT") return "BLOCKED_INSUFFICIENT_CONTEXT";
  return "BLOCKED_TRANSFORM_OVERLAP";
}

async function prepareRegion(options: {
  session: TryOnSession;
  sourceBytes: Uint8Array;
  providerBytes: Uint8Array;
  result: SessionProtectedRegionResult;
}): Promise<PreparedRegion | null> {
  if (options.result.state === "PRESERVED") return null;
  const region = options.session.protectedRegions.find((item) => item.id === options.result.id);
  if (!region || !options.session.sourceImage || !options.session.providerResult) return null;
  const [policy, policyV2] = await Promise.all([
    readPreservePolicy(resolve(repositoryRoot(), "config/preserve-policy.json")),
    readPreservePolicyV2(resolve(repositoryRoot(), "config/preserve-policy-v2.json")),
  ]);
  const source = await rawImage(options.sourceBytes, options.session.sourceImage.width, options.session.sourceImage.height);
  const provider = await rawImage(options.providerBytes, source.width, source.height);
  const engineAttempt = new DeterministicSourceRestoreV1().attempt({
    sessionId: options.session.id,
    sourceHash: hash(options.sourceBytes),
    providerResultHash: hash(options.providerBytes),
    generatedInputHash: hash(options.providerBytes),
    generatedInputProvenance: "REAL_PROVIDER_RESULT",
    source,
    transformationReference: provider,
    providerResult: provider,
    region,
    continuity: options.session.continuity,
    mapping: mapping(options.session),
    initialVerification: { decision: options.result.state === "NOT_EVALUATED" ? "CHANGED" : options.result.state, measurements: options.result.measurements },
    policy,
  });
  const pose = poseEvidence(options.session);
  const estimate = new UpperBodyPoseIntentZoneV1().estimate(pose ?? {
    implementation: "unavailable", model: { name: "unavailable", sha256: "" }, poses_detected: 0, landmarks: [],
  }, policyV2);
  const intent = evaluateIntentAwareEligibility({ attempt: engineAttempt, intent: estimate, policy: policyV2 });
  return { attempt: engineAttempt, intent, eligibility: eligibilityState(intent.evidence) };
}

export async function hydratePreservationEligibility(session: TryOnSession, repository: SessionRepository): Promise<void> {
  if (!session.sourceImage || !session.providerResult || !session.protectedRegionResults.length) return;
  const [sourceBytes, providerBytes] = await Promise.all([
    repository.readAsset(session.id, session.sourceImage), repository.readAsset(session.id, session.providerResult),
  ]);
  for (const result of session.protectedRegionResults) {
    const latest = [...session.preservationAttempts].reverse().find((attempt) => attempt.regionId === result.id);
    if (latest) { result.repairEligibility = latest.eligibility; result.repairState = latest.state; continue; }
    if (result.state === "PRESERVED") { result.repairEligibility = "NOT_NEEDED"; result.repairState = "NOT_REQUESTED"; continue; }
    const prepared = await prepareRegion({ session, sourceBytes, providerBytes, result });
    result.repairEligibility = prepared?.eligibility ?? "BLOCKED_INSUFFICIENT_CONTEXT";
    result.repairState = "NOT_REQUESTED";
  }
}

function publicTrace(trace: PreservationTrace, prepared: PreparedRegion): Record<string, unknown> {
  return {
    schema_version: "2.0",
    provider_result_immutable: true,
    repair_implementation: trace.repair_implementation,
    eligibility_policy: prepared.intent.evidence,
    source_hash: trace.source_hash,
    provider_result_hash: trace.provider_result_hash,
    generated_input_hash: trace.generated_input_hash,
    output_hash: trace.output_hash,
    mapping: trace.mapping,
    initial_verification: trace.initial_verification,
    final_verification: trace.final_verification,
    verification_deltas: trace.verification_deltas,
    outer_ring_verification: trace.outer_ring_verification,
    full_image_change_accounting: trace.full_image_change_accounting,
    repair_method: trace.repair_method,
    outcome: trace.outcome,
    provider_calls: 0,
    youcam_units: 0,
  };
}

async function snapshot(source: RawImage, generated: RawImage, attempt: PreserveAttempt): Promise<VerificationSnapshot> {
  const policy = await readPolicy(resolve(repositoryRoot(), "config/preservation-policy.json"));
  const mask = createRegionMask({ ...attempt.input.region, polygon: attempt.mapping.target_polygon }, source.width, source.height);
  const measurements = measureRegion(source, generated, mask, policy.pixel_tolerance_8bit, policy.sobel_edge_threshold_normalized).measurements;
  return { decision: evaluatePolicy(measurements, policy).decision, measurements };
}

function attemptState(outcome: PreservationTrace["outcome"]): RepairState {
  if (outcome === "RESTORED") return "RESTORED";
  if (outcome === "IMPROVED_BUT_REVIEW") return "IMPROVED_BUT_REVIEW";
  if (outcome === "UNCHANGED" || outcome === "NOT_NEEDED") return "UNCHANGED";
  if (outcome.startsWith("REPAIR_BLOCKED_")) return "BLOCKED";
  return "FAILED";
}

async function encodePng(image: RawImage): Promise<Buffer> {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function composeAccepted(session: TryOnSession, repository: SessionRepository, provider: RawImage, pending?: SessionPreservationAttempt): Promise<RawImage> {
  const accepted = [...session.preservationAttempts.filter((item) => item.id !== pending?.id && (item.state === "RESTORED" || item.state === "IMPROVED_BUT_REVIEW")), ...(pending && (pending.state === "RESTORED" || pending.state === "IMPROVED_BUT_REVIEW") ? [pending] : [])]
    .sort((left, right) => left.regionId.localeCompare(right.regionId) || left.id.localeCompare(right.id));
  const output: RawImage = { ...provider, data: Buffer.from(provider.data) };
  for (const item of accepted) {
    if (!item.resultAsset) continue;
    const patchBytes = item === pending ? await repository.readAsset(session.id, item.resultAsset) : await repository.readAsset(session.id, item.resultAsset);
    const repaired = await rawImage(patchBytes, provider.width, provider.height);
    for (let pixel = 0; pixel < provider.width * provider.height; pixel += 1) {
      const offset = pixel * 3;
      if (repaired.data[offset] === provider.data[offset] && repaired.data[offset + 1] === provider.data[offset + 1] && repaired.data[offset + 2] === provider.data[offset + 2]) continue;
      repaired.data.copy(output.data, offset, offset, offset + 3);
    }
  }
  return output;
}

export async function preserveRegion(options: {
  session: TryOnSession;
  repository: SessionRepository;
  regionId: string;
  inputVersion: number;
  idempotencyKey: string;
}): Promise<TryOnSession> {
  const { session, repository } = options;
  if (!session.sourceImage || !session.providerResult || session.provider.state !== "SUCCESS") throw new PreservationError("PRESERVE_INPUT_UNAVAILABLE", "The original and AI result must still be available.");
  const duplicate = session.preservationAttempts.find((item) => item.regionId === options.regionId && item.idempotencyKey === options.idempotencyKey);
  if (duplicate) return session;
  if (options.inputVersion !== session.preservationVersion) throw new PreservationError("PRESERVE_VERSION_CONFLICT", "This result has a newer preserved version. Refresh and try again.");
  const result = session.protectedRegionResults.find((item) => item.id === options.regionId);
  if (!result) throw new PreservationError("PRESERVE_REGION_INVALID", "That protected area is not available for restoration.");
  const now = new Date().toISOString();
  const record: SessionPreservationAttempt = {
    id: randomUUID(), regionId: result.id, regionLabel: result.label, idempotencyKey: options.idempotencyKey,
    inputVersion: options.inputVersion, outputVersion: null, eligibility: "BLOCKED_INSUFFICIENT_CONTEXT", state: "PROCESSING",
    sourceHash: null, providerResultHash: null, generatedInputHash: null, outputHash: null,
    providerCalls: 0, youcamUnits: 0, engineVersion: "PRESERVE_ENGINE_V1", eligibilityPolicyVersion: "2.0.0",
    intentEstimator: "UpperBodyPoseIntentZoneV1", resultAsset: null, trace: null, createdAt: now, completedAt: null,
  };
  const [sourceBytes, providerBytes] = await Promise.all([
    repository.readAsset(session.id, session.sourceImage), repository.readAsset(session.id, session.providerResult),
  ]);
  const prepared = await prepareRegion({ session, sourceBytes, providerBytes, result });
  if (!prepared) throw new PreservationError("PRESERVE_NOT_NEEDED", "This area is already preserved.");
  record.eligibility = prepared.eligibility;
  const claimed = await repository.claimPreservation(session, record);
  if (claimed === "DUPLICATE") return await repository.getOwned(session.id, session.ownerId) ?? session;
  if (claimed === "BUSY") throw new PreservationError("PRESERVE_BUSY", "Another area is being restored. Wait for it to finish, then try again.");
  session.preservationAttempts.push(record);
  result.repairEligibility = record.eligibility; result.repairState = "PROCESSING";
  try {
    if (record.eligibility !== "ELIGIBLE") {
      record.state = "BLOCKED"; record.completedAt = new Date().toISOString();
      record.sourceHash = prepared.attempt.sourceHash; record.providerResultHash = prepared.attempt.providerResultHash;
      record.generatedInputHash = prepared.attempt.input.generatedInputHash;
      record.trace = { schema_version: "2.0", provider_result_immutable: true, eligibility_policy: prepared.intent.evidence, provider_calls: 0, youcam_units: 0 };
      result.repairState = "BLOCKED";
      await repository.completePreservation(session, record);
      return session;
    }
    const applied = applyV2ApprovedRestore(prepared.attempt);
    const final = await snapshot(applied.input.source, applied.repaired, applied);
    const trace = completePreservationTrace(applied, final);
    record.state = attemptState(trace.outcome); record.completedAt = new Date().toISOString();
    record.sourceHash = trace.source_hash; record.providerResultHash = trace.provider_result_hash;
    record.generatedInputHash = trace.generated_input_hash; record.outputHash = trace.output_hash;
    record.trace = publicTrace(trace, prepared);
    const repairArtifacts = await withPreserveWorkspace(async (workspace) => {
      const artifactRoot = resolve(workspace, "repair-evidence");
      await writePreserveAttemptArtifacts(artifactRoot, applied, trace);
      return repository.persistDerived(session.id, artifactRoot);
    });
    session.derivedBlobKeys.push(...repairArtifacts);
    record.trace = { ...record.trace, private_artifact_count: repairArtifacts.length };
    if (record.state === "RESTORED" || record.state === "IMPROVED_BUT_REVIEW") {
      const repairBytes = await encodePng(applied.repaired);
      record.resultAsset = await repository.writeAsset(session.id, {
        kind: "repair", filename: `repair-${record.id}.png`, mediaType: "image/png", width: applied.repaired.width, height: applied.repaired.height, size: repairBytes.byteLength,
      }, repairBytes);
      const composite = await composeAccepted(session, repository, prepared.attempt.input.providerResult, record);
      const compositeBytes = await encodePng(composite);
      const previousPreserved = session.preservedResult;
      const previousPassport = session.passportImage;
      session.preservedResult = await repository.writeAsset(session.id, {
        kind: "preserved", filename: `preserved-${session.id}-v${session.preservationVersion + 1}.png`, mediaType: "image/png", width: composite.width, height: composite.height, size: compositeBytes.byteLength,
      }, compositeBytes);
      session.preservationVersion += 1; record.outputVersion = session.preservationVersion;
      result.state = final.decision; result.measurements = final.measurements;
      result.repairEligibility = record.eligibility; result.repairState = record.state;
      session.finalState = session.protectedRegionResults.some((item) => item.state !== "PRESERVED") ? "READY_WITH_REVIEW" : "READY_VERIFIED";
      await withPreserveWorkspace(async (workspace) => {
        const currentPath = resolve(workspace, "current-preserved.png");
        await writeFile(currentPath, compositeBytes);
        const passport = await renderPassportPng(session, currentPath);
        session.passportImage = await repository.writeAsset(session.id, { kind: "passport", filename: `passport-${session.id}-v${session.preservationVersion}.png`, mediaType: "image/png", width: 1080, height: 1350, size: passport.byteLength }, passport);
      });
      await repository.completePreservation(session, record);
      await repository.deleteAssets(session.id, [previousPreserved, previousPassport]).catch(() => undefined);
    } else {
      result.repairState = record.state;
      await repository.completePreservation(session, record);
    }
    result.repairEligibility = record.eligibility; result.repairState = record.state;
    return session;
  } catch (error) {
    record.state = "FAILED"; record.completedAt = new Date().toISOString(); result.repairState = "FAILED";
    record.trace = { schema_version: "2.0", provider_result_immutable: true, eligibility_policy: prepared.intent.evidence, failure_code: "PRESERVE_EXECUTION_FAILED", provider_calls: 0, youcam_units: 0 };
    await repository.completePreservation(session, record).catch(() => undefined);
    throw error;
  }
}

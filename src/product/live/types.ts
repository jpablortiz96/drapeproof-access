import type { NormalizedPoint, PolicyDecision, RegionMeasurements } from "../../verification/types.js";

export type TryOnCategory = "CLOTHING" | "BAG";
export type SessionStage = "PHOTO" | "PRODUCT" | "PROTECT" | "REVIEW" | "CREATING" | "CONTINUITY" | "REGIONS" | "FACE" | "COMPLETE" | "FAILED";
export type FinalState = "PROCESSING" | "READY_VERIFIED" | "READY_WITH_REVIEW" | "PREVIEW_NOT_VERIFIABLE" | "PROVIDER_FAILED";
export type ProviderState = "NOT_STARTED" | "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
export type ProviderPhase = "PENDING" | "PROVIDER_SUBMITTED" | "PROVIDER_RUNNING" | "PROVIDER_SUCCESS" | "PROVIDER_FAILED";
export type FaceAppearanceState = "NOT_CHECKED" | "CHECKING" | "CHECKED" | "UNAVAILABLE";
export type PublicVerificationState = "PRESERVED" | "REVIEW" | "CHANGED" | "NOT_EVALUATED";
export type RepairEligibilityState =
  | "ELIGIBLE"
  | "BLOCKED_CONTINUITY"
  | "BLOCKED_ALIGNMENT"
  | "BLOCKED_TRANSFORM_OVERLAP"
  | "BLOCKED_TRANSFORM_PROXIMITY"
  | "BLOCKED_INSUFFICIENT_CONTEXT"
  | "NOT_NEEDED";
export type RepairState = "NOT_REQUESTED" | "PROCESSING" | "RESTORED" | "IMPROVED_BUT_REVIEW" | "UNCHANGED" | "FAILED" | "BLOCKED";

export interface SessionAsset {
  kind: "source" | "product" | "result" | "face-control" | "passport" | "preserved" | "repair";
  filename: string;
  storageKey?: string;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  size: number;
}

export interface UserProtectedRegion {
  id: string;
  label: string;
  polygon: NormalizedPoint[];
}

export interface ProviderProgress {
  state: ProviderState;
  phase?: ProviderPhase;
  product: "AI Clothes Virtual Try-On" | "AI Bag Virtual Try-On";
  version: "Clothes V4.0" | "Bag Virtual Try-On V2.0";
  taskId?: string;
  idempotencyKey?: string;
  startedAt?: string;
  submittedAt?: string;
  errorCode?: string;
  error?: string;
}

export interface ContinuitySignalResult {
  key: "frame" | "pose" | "features" | "regions";
  status: "PASS" | "REVIEW" | "FAIL";
  reasonCodes: string[];
  raw: Record<string, unknown>;
}

export interface SessionContinuityResult {
  state: "NOT_CHECKED" | "CHECKING" | "CONSISTENT" | "NEEDS_REVIEW" | "CHANGED_TOO_MUCH" | "UNAVAILABLE";
  localVerificationEligible: boolean;
  reasonCodes: string[];
  signals: ContinuitySignalResult[];
}

export interface SessionProtectedRegionResult {
  id: string;
  label: string;
  state: PublicVerificationState;
  measurements: RegionMeasurements;
  artifactDirectory: string;
  repairEligibility?: RepairEligibilityState;
  repairState?: RepairState;
}

export interface SessionPreservationAttempt {
  id: string;
  regionId: string;
  regionLabel: string;
  idempotencyKey: string;
  inputVersion: number;
  outputVersion: number | null;
  eligibility: RepairEligibilityState;
  state: RepairState;
  sourceHash: string | null;
  providerResultHash: string | null;
  generatedInputHash: string | null;
  outputHash: string | null;
  providerCalls: 0;
  youcamUnits: 0;
  engineVersion: "PRESERVE_ENGINE_V1";
  eligibilityPolicyVersion: "2.0.0";
  intentEstimator: "UpperBodyPoseIntentZoneV1";
  resultAsset: SessionAsset | null;
  trace: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}

export interface FaceSignalValue {
  concern: "texture" | "pore" | "redness" | "radiance";
  original: number;
  control: number;
  result: number;
  controlDelta: number;
  resultDelta: number;
}

export interface FaceAppearanceResult {
  state: FaceAppearanceState;
  enabled: boolean;
  taskIds?: { original: string; control: string; result: string };
  signals?: FaceSignalValue[];
  error?: string;
}

export interface TryOnSession {
  schemaVersion: "1.0";
  id: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  category: TryOnCategory | null;
  sourceImage: SessionAsset | null;
  productImage: SessionAsset | null;
  providerResult: SessionAsset | null;
  preservedResult: SessionAsset | null;
  preservationVersion: number;
  preservationAttempts: SessionPreservationAttempt[];
  protectedRegions: UserProtectedRegion[];
  provider: ProviderProgress;
  continuity: SessionContinuityResult;
  protectedRegionResults: SessionProtectedRegionResult[];
  faceAppearance: FaceAppearanceResult;
  passportImage: SessionAsset | null;
  derivedBlobKeys: string[];
  cleanupFailures: string[];
  stage: SessionStage;
  finalState: FinalState;
  deletedAt: string | null;
  qaFixture: "UI_ONLY_NO_PROVIDER_EVENT" | null;
}

type PublicAsset = Omit<SessionAsset, "storageKey" | "filename">;
type PublicFaceAppearance = Omit<FaceAppearanceResult, "taskIds">;
type PublicRegionResult = Omit<SessionProtectedRegionResult, "artifactDirectory">;
type PublicPreservationAttempt = Omit<SessionPreservationAttempt, "idempotencyKey" | "resultAsset" | "trace"> & {
  trace: Record<string, unknown> | null;
};

export interface PublicTryOnSession extends Omit<TryOnSession, "ownerId" | "provider" | "sourceImage" | "productImage" | "providerResult" | "preservedResult" | "passportImage" | "derivedBlobKeys" | "cleanupFailures" | "faceAppearance" | "protectedRegionResults" | "preservationAttempts"> {
  provider: Omit<ProviderProgress, "taskId" | "idempotencyKey">;
  sourceImage: PublicAsset | null;
  productImage: PublicAsset | null;
  providerResult: PublicAsset | null;
  preservedResult: PublicAsset | null;
  faceAppearance: PublicFaceAppearance;
  protectedRegionResults: PublicRegionResult[];
  preservationAttempts: PublicPreservationAttempt[];
  assetUrls: { source: string | null; product: string | null; result: string | null; preserved: string | null; current: string | null };
}

export function publicSession(session: TryOnSession): PublicTryOnSession {
  const { ownerId: _ownerId, provider, sourceImage, productImage, providerResult, preservedResult, passportImage: _passportImage, derivedBlobKeys: _derivedBlobKeys, cleanupFailures: _cleanupFailures, faceAppearance, protectedRegionResults, preservationAttempts, ...rest } = session;
  const { taskId: _taskId, idempotencyKey: _idempotencyKey, ...publicProvider } = provider;
  const { taskIds: _faceTaskIds, ...publicFace } = faceAppearance;
  const asset = (value: SessionAsset | null): PublicAsset | null => {
    if (!value) return null;
    const { storageKey: _storageKey, filename: _filename, ...safe } = value;
    return safe;
  };
  const base = `/api/sessions/${encodeURIComponent(session.id)}/asset`;
  return {
    ...rest,
    provider: publicProvider,
    sourceImage: asset(sourceImage),
    productImage: asset(productImage),
    providerResult: asset(providerResult),
    preservedResult: asset(preservedResult),
    faceAppearance: publicFace,
    protectedRegionResults: protectedRegionResults.map(({ artifactDirectory: _artifactDirectory, ...result }) => result),
    preservationAttempts: preservationAttempts.map(({ idempotencyKey: _idempotencyKey, resultAsset: _resultAsset, trace, ...attempt }) => ({ ...attempt, trace: trace ? publicPreservationTrace(trace) : null })),
    assetUrls: {
      source: session.sourceImage ? `${base}/source?display=1` : null,
      product: session.productImage ? `${base}/product?display=1` : null,
      result: session.providerResult ? `${base}/result?display=1` : null,
      preserved: session.preservedResult ? `${base}/preserved?display=1` : null,
      current: session.preservedResult ? `${base}/preserved?display=1` : session.providerResult ? `${base}/result?display=1` : null,
    },
  };
}

function publicPreservationTrace(trace: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...trace };
  for (const key of ["storage_key", "repair_blob_key", "idempotency_key", "private_artifacts"]) delete safe[key];
  return safe;
}

export function consumerRegionState(decision: PolicyDecision): SessionProtectedRegionResult["state"] {
  return decision;
}

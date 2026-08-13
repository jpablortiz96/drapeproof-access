import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateRegionDefinition } from "../../verification/regions.js";
import { verifyRegions } from "../../verification/verification.js";
import { runLiveContinuityFromBytes } from "./continuity.js";
import { pollFaceAppearance, startFaceAppearance } from "./face.js";
import { renderPassportPng } from "./passport.js";
import { repositoryRoot } from "./paths.js";
import { fixtureFromAsset, ProviderSubmissionError, type LiveGenerationProvider } from "./provider.js";
import type { SessionRepository } from "./repository.js";
import { normalizeImageUpload } from "./uploads.js";
import type { TryOnSession } from "./types.js";
import { logServerEvent } from "../production/logging.js";
import { sanitizedVerificationError } from "./verification-errors.js";
import { withVerificationWorkspace } from "./verification-workspace.js";
import { hydratePreservationEligibility } from "./preservation.js";
import type { ProviderBudgetGuard } from "../beta/budget.js";

export class ProductFlowError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ProductFlowError"; }
}

export class GenerationControlError extends ProductFlowError {
  constructor(public readonly controlCode: "GENERATION_PAUSED" | "DAILY_BUDGET_EXHAUSTED", message: string) { super(controlCode, message); this.name = "GenerationControlError"; }
}

export interface GenerationControls {
  enabled: boolean;
  budget: number;
  expectedUnits: number;
  guard: ProviderBudgetGuard;
}

const PROVIDER_TIMEOUT_MS = 5 * 60 * 1_000;

function finalize(session: TryOnSession): void {
  session.stage = "COMPLETE";
  session.finalState = session.protectedRegionResults.some((region) => region.state !== "PRESERVED") ? "READY_WITH_REVIEW" : "READY_VERIFIED";
}

export function routeAfterContinuity(localVerificationEligible: boolean, protectedRegionCount: number, faceEnabled: boolean): { stage: TryOnSession["stage"]; finalState?: TryOnSession["finalState"] } {
  if (!localVerificationEligible) return { stage: "COMPLETE", finalState: "PREVIEW_NOT_VERIFIABLE" };
  if (protectedRegionCount > 0) return { stage: "REGIONS" };
  if (faceEnabled) return { stage: "FACE" };
  return { stage: "COMPLETE", finalState: "READY_VERIFIED" };
}

export async function startLiveGeneration(session: TryOnSession, repository: SessionRepository, provider: LiveGenerationProvider, idempotencyKey: string = randomUUID(), controls?: GenerationControls): Promise<TryOnSession> {
  if (!session.sourceImage) throw new ProductFlowError("PHOTO_REQUIRED", "Add your photo before creating a preview.");
  if (!session.productImage || !session.category) throw new ProductFlowError("PRODUCT_REQUIRED", "Choose a product type and add a product image.");
  if (session.protectedRegions.length) validateRegionDefinition({ schema_version: "1.0", coordinate_space: "normalized", regions: session.protectedRegions });
  if (session.provider.state !== "NOT_STARTED") return session;
  if (controls && !controls.enabled) throw new GenerationControlError("GENERATION_PAUSED", "New try-ons are temporarily paused.");
  const [sourcePath, productPath] = await Promise.all([
    repository.materializeAsset(session.id, session.sourceImage),
    repository.materializeAsset(session.id, session.productImage),
  ]);
  if (controls) {
    const reservation = await controls.guard.reserve({ reservationKey: idempotencyKey, sessionId: session.id, category: session.category, expectedUnits: controls.expectedUnits, budget: controls.budget });
    if (reservation.decision === "BUDGET_EXHAUSTED") throw new GenerationControlError("DAILY_BUDGET_EXHAUSTED", "Try-ons are temporarily full for today.");
  }
  session.stage = "CREATING";
  session.finalState = "PROCESSING";
  session.provider = {
    state: "PENDING",
    product: session.category === "CLOTHING" ? "AI Clothes Virtual Try-On" : "AI Bag Virtual Try-On",
    version: session.category === "CLOTHING" ? "Clothes V4.0" : "Bag Virtual Try-On V2.0",
    startedAt: new Date().toISOString(),
    idempotencyKey,
  };
  if (!await repository.claimGeneration(session)) return await repository.get(session.id) ?? session;
  try {
    const started = await provider.start(
      session.category,
      fixtureFromAsset(sourcePath, session.sourceImage),
      fixtureFromAsset(productPath, session.productImage),
    );
    if (controls) {
      await controls.guard.markSubmitted(idempotencyKey, started.taskId).catch((error) => {
        logServerEvent("provider.budget_relationship_deferred", { session_id: session.id, phase: "provider-submit", error_code: "BUDGET_RELATIONSHIP_DEFERRED", error });
      });
    }
    session.provider = { ...session.provider, state: "RUNNING", phase: "PROVIDER_SUBMITTED", submittedAt: new Date().toISOString(), ...started };
  } catch (error) {
    if (controls) {
      if (error instanceof ProviderSubmissionError && error.definitePreAcceptance) await controls.guard.releaseDefinitePreAcceptance(idempotencyKey).catch(() => false);
      else await controls.guard.markUncertain(idempotencyKey).catch(() => undefined);
    }
    const errorCode = error instanceof ProviderSubmissionError && error.definitePreAcceptance ? "PROVIDER_REJECTED" : "PROVIDER_UNAVAILABLE";
    session.provider = { ...session.provider, state: "FAILED", errorCode, error: "The preview could not be created. Try again later." };
    session.stage = "FAILED";
    session.finalState = "PROVIDER_FAILED";
  }
  await repository.save(session);
  return session;
}

async function executeContinuity(session: TryOnSession, repository: SessionRepository): Promise<{ derivedKeys: string[]; result: TryOnSession["continuity"] }> {
  if (!session.sourceImage || !session.providerResult) throw new Error("Continuity requires source and result images.");
  return withVerificationWorkspace(async (workspace) => {
    const outputRoot = resolve(workspace, "continuity");
    const [sourceBytes, resultBytes] = await Promise.all([
      repository.readAsset(session.id, session.sourceImage!),
      repository.readAsset(session.id, session.providerResult!),
    ]);
    const result = await runLiveContinuityFromBytes({ sourceBytes, resultBytes, regions: session.protectedRegions, outputRoot });
    return { result, derivedKeys: await repository.persistDerived(session.id, outputRoot) };
  });
}

async function completeContinuity(session: TryOnSession, repository: SessionRepository): Promise<void> {
  try {
    const output = await executeContinuity(session, repository);
    session.continuity = output.result;
    session.derivedBlobKeys.push(...output.derivedKeys);
  } catch (error) {
    const diagnostic = sanitizedVerificationError(error);
    logServerEvent("verification.continuity_failed", { session_id: session.id, phase: "continuity", ...diagnostic });
    session.continuity = { state: "UNAVAILABLE", localVerificationEligible: false, reasonCodes: [diagnostic.failureCode], signals: [] };
  }
  const route = routeAfterContinuity(session.continuity.localVerificationEligible, session.protectedRegions.length, session.faceAppearance.enabled);
  session.stage = route.stage;
  if (route.finalState) session.finalState = route.finalState;
  if (!session.continuity.localVerificationEligible) {
    session.faceAppearance = { ...session.faceAppearance, state: "NOT_CHECKED" };
  }
}

async function executeRegions(session: TryOnSession, repository: SessionRepository): Promise<{ derivedKeys: string[]; results: TryOnSession["protectedRegionResults"] }> {
  if (!session.sourceImage || !session.providerResult) throw new Error("Protected-area verification requires source and result images.");
  return withVerificationWorkspace(async (workspace) => {
    const sourcePath = resolve(workspace, "source-image");
    const resultPath = resolve(workspace, "result-image");
    const regionPath = resolve(workspace, "protected-regions.json");
    const outputRoot = resolve(workspace, "region-results");
    const definition = validateRegionDefinition({ schema_version: "1.0", coordinate_space: "normalized", regions: session.protectedRegions });
    const [sourceBytes, resultBytes] = await Promise.all([
      repository.readAsset(session.id, session.sourceImage!),
      repository.readAsset(session.id, session.providerResult!),
    ]);
    await Promise.all([
      writeFile(sourcePath, sourceBytes),
      writeFile(resultPath, resultBytes),
      writeFile(regionPath, `${JSON.stringify(definition, null, 2)}\n`, "utf8"),
    ]);
    const outputs = await verifyRegions({
      originalPath: sourcePath,
      generatedPath: resultPath,
      regionsPath: regionPath,
      policyPath: resolve(repositoryRoot(), "config/preservation-policy.json"),
      outputRoot,
    });
    return {
      derivedKeys: await repository.persistDerived(session.id, outputRoot),
      results: outputs.map((output) => ({
        id: output.region.id, label: output.region.label, state: output.decision,
        measurements: output.measurements, artifactDirectory: "private-derived-artifacts",
      })),
    };
  });
}

async function completeRegions(session: TryOnSession, repository: SessionRepository): Promise<void> {
  const output = await executeRegions(session, repository);
  session.derivedBlobKeys.push(...output.derivedKeys);
  session.protectedRegionResults = output.results;
  await hydratePreservationEligibility(session, repository);
  if (session.faceAppearance.enabled) session.stage = "FACE";
  else finalize(session);
}

export interface ReverificationResult {
  session: TryOnSession;
  localVerification: "EXECUTED" | "BLOCKED_BY_CONTINUITY" | "NOT_REQUESTED_NO_PROTECTED_REGIONS";
  passportRebuilt: boolean;
}

export async function reverifyExistingResult(session: TryOnSession, repository: SessionRepository): Promise<ReverificationResult> {
  if (session.provider.state !== "SUCCESS" || !session.sourceImage || !session.providerResult) throw new ProductFlowError("VERIFIER_INPUT_UNAVAILABLE", "The existing provider result is unavailable for re-verification.");
  const previousDerived = [...session.derivedBlobKeys];
  const previousPassport = session.passportImage;
  const continuityOutput = await executeContinuity(session, repository);
  session.continuity = continuityOutput.result;
  session.derivedBlobKeys = [...continuityOutput.derivedKeys];
  session.protectedRegionResults = [];
  session.faceAppearance = { ...session.faceAppearance, state: "NOT_CHECKED" };
  let localVerification: ReverificationResult["localVerification"];
  if (!session.continuity.localVerificationEligible) {
    session.stage = "COMPLETE";
    session.finalState = "PREVIEW_NOT_VERIFIABLE";
    localVerification = "BLOCKED_BY_CONTINUITY";
  } else if (session.protectedRegions.length === 0) {
    session.stage = "COMPLETE";
    session.finalState = "READY_VERIFIED";
    localVerification = "NOT_REQUESTED_NO_PROTECTED_REGIONS";
  } else {
    const regionOutput = await executeRegions(session, repository);
    session.derivedBlobKeys.push(...regionOutput.derivedKeys);
    session.protectedRegionResults = regionOutput.results;
    await hydratePreservationEligibility(session, repository);
    finalize(session);
    localVerification = "EXECUTED";
  }
  const passportBytes = await withVerificationWorkspace(async (workspace) => {
    const resultPath = resolve(workspace, "result-image");
    await writeFile(resultPath, await repository.readAsset(session.id, session.providerResult!));
    return new Uint8Array(await renderPassportPng(session, resultPath));
  });
  session.passportImage = await repository.writeAsset(session.id, {
    kind: "passport", filename: `passport-${session.id}.png`, mediaType: "image/png", width: 1080, height: 1350, size: passportBytes.byteLength,
  }, passportBytes);
  await repository.save(session);
  await Promise.all([
    previousDerived.length ? repository.deleteDerived(session.id, previousDerived) : Promise.resolve(),
    previousPassport ? repository.deleteAssets(session.id, [previousPassport]) : Promise.resolve(),
  ]).catch((error) => logServerEvent("verification.old_artifact_cleanup_failed", { session_id: session.id, phase: "cleanup", error_code: "STORAGE_DELETE_FAILED", error }));
  return { session, localVerification, passportRebuilt: true };
}

export async function advanceLiveSession(session: TryOnSession, repository: SessionRepository, provider: LiveGenerationProvider): Promise<TryOnSession> {
  if (session.finalState !== "PROCESSING") return session;
  try {
    if (session.stage === "CREATING") {
      if (!session.category) throw new Error("Provider task state is incomplete.");
      if (session.provider.state === "PENDING" && !session.provider.taskId) {
        if (session.provider.startedAt && Date.now() - Date.parse(session.provider.startedAt) > 60_000) {
          session.provider = { ...session.provider, state: "FAILED", errorCode: "PROVIDER_UNAVAILABLE", error: "The preview could not be started safely. Please begin a new try-on." };
          session.stage = "FAILED"; session.finalState = "PROVIDER_FAILED";
          await repository.save(session);
        }
        return session;
      }
      if (!session.provider.taskId) throw new Error("Provider task state is incomplete.");
      if (session.provider.startedAt && Date.now() - Date.parse(session.provider.startedAt) > PROVIDER_TIMEOUT_MS) {
        session.provider = { ...session.provider, state: "FAILED", errorCode: "PROVIDER_TIMEOUT", error: "This preview is taking longer than expected. Start again or try another image." };
        session.stage = "FAILED";
        session.finalState = "PROVIDER_FAILED";
        await repository.save(session);
        return session;
      }
      const polled = await provider.poll(session.category, session.provider.taskId);
      if (polled.state === "RUNNING") {
        if (session.provider.phase !== "PROVIDER_RUNNING") { session.provider = { ...session.provider, state: "RUNNING", phase: "PROVIDER_RUNNING" }; await repository.save(session); }
        return session;
      }
      if (polled.state === "FAILED" || !polled.result) {
        session.provider = { ...session.provider, state: "FAILED", phase: "PROVIDER_FAILED", errorCode: "PROVIDER_REJECTED", error: polled.error ?? "The preview could not be created." };
        session.stage = "FAILED"; session.finalState = "PROVIDER_FAILED";
      } else {
        const normalized = await normalizeImageUpload({ kind: "result", originalName: "generated-result.jpg", mediaType: polled.result.mediaType?.split(";")[0] ?? "image/jpeg", bytes: polled.result.bytes });
        session.providerResult = await repository.writeAsset(session.id, normalized.asset, normalized.bytes);
        session.provider = { ...session.provider, state: "SUCCESS", phase: "PROVIDER_SUCCESS" };
        session.stage = "CONTINUITY";
        session.continuity = { state: "CHECKING", localVerificationEligible: false, reasonCodes: [], signals: [] };
      }
    } else if (session.stage === "CONTINUITY") {
      await completeContinuity(session, repository);
    } else if (session.stage === "REGIONS") {
      await completeRegions(session, repository);
    } else if (session.stage === "FACE") {
      if (session.faceAppearance.state !== "CHECKING") await startFaceAppearance(session, repository);
      else if (await pollFaceAppearance(session) === "COMPLETE") finalize(session);
    }
  } catch (error) {
    if (session.stage === "FACE") {
      session.faceAppearance = { enabled: true, state: "UNAVAILABLE", error: "Face appearance could not be checked for this preview." };
      finalize(session);
    } else if (session.provider.state === "SUCCESS") {
      const diagnostic = sanitizedVerificationError(error);
      logServerEvent("verification.session_failed", { session_id: session.id, phase: session.stage.toLowerCase(), ...diagnostic });
      if (session.stage === "REGIONS") {
        session.continuity = { ...session.continuity, localVerificationEligible: false, reasonCodes: [...new Set([...session.continuity.reasonCodes, "REGION_ALIGNMENT_FAILED"])] };
      } else {
        session.continuity = { state: "UNAVAILABLE", localVerificationEligible: false, reasonCodes: [diagnostic.failureCode], signals: [] };
      }
      session.stage = "COMPLETE"; session.finalState = "PREVIEW_NOT_VERIFIABLE";
    } else {
      session.provider = { ...session.provider, state: "FAILED", errorCode: "PROVIDER_UNAVAILABLE", error: error instanceof Error ? error.message : "The preview could not be created." };
      session.stage = "FAILED"; session.finalState = "PROVIDER_FAILED";
    }
  }
  await repository.save(session);
  return session;
}

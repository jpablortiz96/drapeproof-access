import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { GenerationControlError, YouCamLiveGenerationProvider, advanceLiveSession, startLiveGeneration } from "@web/server/live";
import { enforceRateLimit, notFoundSession, ownedSession, ownerFromRequest, productError, requestId, requireMutationOrigin, sessionResponse } from "@web/server/api";
import { providerBudget, sessions } from "@web/server/session-context";
import { generationEnabled, providerDailyUnitBudget, providerOperationUnits } from "@drapeproof/product/production/config";
import { safeRecordProductEvent } from "@web/server/product-events";
import { durationBucket } from "@drapeproof/product/beta/events";
import { PreservationError, preserveRegion } from "@drapeproof/product/live/preservation";
import { logServerEvent } from "@drapeproof/product/production/logging";

type SessionRouteContext = { params: Promise<{ id: string }> };

export async function generateSession(request: NextRequest, { params }: SessionRouteContext) {
  const originError = requireMutationOrigin(request); if (originError) return originError;
  const { id } = await params;
  const session = await ownedSession(request, id);
  if (!session) return notFoundSession();
  if (!session.sourceImage || !session.productImage || !session.category) return productError("Add both images and choose a product type first.", "Return to the try-on review.", 400, "REQUEST_INVALID");
  if (session.provider.state !== "NOT_STARTED") return sessionResponse(session);
  if (!generationEnabled()) return productError("New try-ons are temporarily paused.", "Back to home.", 503, "GENERATION_PAUSED");
  const rateError = await enforceRateLimit(request, "generation", ownerFromRequest(request)); if (rateError) return rateError;
  const idempotencyKey = createHash("sha256").update([session.id, session.category, session.sourceImage.storageKey ?? session.sourceImage.filename, session.productImage.storageKey ?? session.productImage.filename].join(":"), "utf8").digest("hex");
  await safeRecordProductEvent(request, { eventName: "review_confirmed", tryOnSessionId: id, category: session.category, properties: { region_count: session.protectedRegions.length }, deduplicationKey: `${id}:review_confirmed:${idempotencyKey.slice(0, 24)}` });
  try {
    const updated = await startLiveGeneration(session, sessions(), new YouCamLiveGenerationProvider(), idempotencyKey, {
      enabled: generationEnabled(), budget: providerDailyUnitBudget(), expectedUnits: providerOperationUnits(session.category), guard: providerBudget(),
    });
    if (updated.provider.state !== "NOT_STARTED") await safeRecordProductEvent(request, { eventName: "generation_started", tryOnSessionId: id, category: session.category, deduplicationKey: `${id}:generation_started:${idempotencyKey.slice(0, 24)}` });
    if (updated.provider.state === "FAILED") await safeRecordProductEvent(request, { eventName: "provider_failed", tryOnSessionId: id, category: session.category, properties: { error_code: updated.provider.errorCode ?? "PROVIDER_UNAVAILABLE" }, deduplicationKey: `${id}:provider_failed:${idempotencyKey.slice(0, 24)}` });
    return sessionResponse(updated);
  } catch (error) {
    if (error instanceof GenerationControlError && error.controlCode === "DAILY_BUDGET_EXHAUSTED") return productError("Try-ons are temporarily full for today.", "We limit daily generations while DrapeProof is in beta. Try again later. Back to home.", 429, error.controlCode);
    if (error instanceof GenerationControlError) return productError("New try-ons are temporarily paused.", "Back to home.", 503, error.controlCode);
    throw error;
  }
}

export async function processSession(request: NextRequest, { params }: SessionRouteContext) {
  const originError = requireMutationOrigin(request); if (originError) return originError;
  const { id } = await params;
  const session = await ownedSession(request, id);
  if (!session) return notFoundSession();
  const rateError = await enforceRateLimit(request, "status", ownerFromRequest(request)); if (rateError) return rateError;
  const previousProvider = session.provider.state; const previousContinuity = session.continuity.state;
  const updated = await advanceLiveSession(session, sessions(), new YouCamLiveGenerationProvider());
  const elapsed = updated.provider.startedAt ? durationBucket(Math.max(0, Date.now() - Date.parse(updated.provider.startedAt))) : "LT_10S";
  if (previousProvider !== "SUCCESS" && updated.provider.state === "SUCCESS") await safeRecordProductEvent(request, { eventName: "provider_succeeded", tryOnSessionId: id, category: updated.category, properties: { duration_bucket: elapsed }, deduplicationKey: `${id}:provider_succeeded:${updated.provider.idempotencyKey?.slice(0, 24) ?? "task"}` });
  if (previousProvider !== "FAILED" && updated.provider.state === "FAILED") await safeRecordProductEvent(request, { eventName: "provider_failed", tryOnSessionId: id, category: updated.category, properties: { error_code: updated.provider.errorCode ?? "PROVIDER_UNAVAILABLE", duration_bucket: elapsed }, deduplicationKey: `${id}:provider_failed:${updated.provider.idempotencyKey?.slice(0, 24) ?? "task"}` });
  if (previousContinuity !== updated.continuity.state && !["NOT_CHECKED", "CHECKING"].includes(updated.continuity.state)) {
    const passed = updated.continuity.state === "CONSISTENT" || updated.continuity.state === "NEEDS_REVIEW";
    await safeRecordProductEvent(request, { eventName: passed ? "continuity_passed" : "continuity_failed", tryOnSessionId: id, category: updated.category, properties: passed ? { continuity_state: updated.continuity.state, duration_bucket: elapsed } : { continuity_state: updated.continuity.state, duration_bucket: elapsed, error_code: updated.continuity.state === "UNAVAILABLE" ? "VERIFICATION_FAILURE" : "CONTINUITY_FAILED" }, deduplicationKey: `${id}:continuity:${updated.continuity.state}` });
  }
  return sessionResponse(updated);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

export async function preserveSession(request: NextRequest, { params }: SessionRouteContext) {
  const originError = requireMutationOrigin(request); if (originError) return originError;
  const { id } = await params;
  const session = await ownedSession(request, id);
  if (!session) return notFoundSession();
  const rateError = await enforceRateLimit(request, "preserve", ownerFromRequest(request)); if (rateError) return rateError;
  let body: { regionId?: unknown; version?: unknown; idempotencyToken?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return productError("The restoration request was not valid.", "Refresh the result and try again.", 400, "PRESERVE_REQUEST_INVALID"); }
  if (typeof body.regionId !== "string" || body.regionId.length < 1 || body.regionId.length > 120 || !Number.isSafeInteger(body.version) || (body.version as number) < 0 || !validToken(body.idempotencyToken)) return productError("The restoration request was not valid.", "Refresh the result and try again.", 400, "PRESERVE_REQUEST_INVALID");
  const started = Date.now();
  const target = session.protectedRegionResults.find((region) => region.id === body.regionId);
  if (target?.repairEligibility) await safeRecordProductEvent(request, { eventName: "preserve_started", tryOnSessionId: id, category: session.category, properties: { repair_eligibility_reason: target.repairEligibility }, deduplicationKey: `${id}:preserve_started:${body.regionId}:${body.version}` });
  try {
    const updated = await preserveRegion({ session, repository: sessions(), regionId: body.regionId, inputVersion: body.version as number, idempotencyKey: body.idempotencyToken });
    logServerEvent("preservation.completed", { request_id: requestId(request), session_id: id, phase: "preserve", duration_ms: Date.now() - started, status: "complete", provider_calls: 0, youcam_units: 0 });
    const outcome = updated.protectedRegionResults.find((region) => region.id === body.regionId)?.repairState;
    if (outcome === "RESTORED" || outcome === "IMPROVED_BUT_REVIEW") await safeRecordProductEvent(request, { eventName: outcome === "RESTORED" ? "preserve_restored" : "preserve_review", tryOnSessionId: id, category: session.category, properties: { repair_outcome: outcome }, deduplicationKey: `${id}:preserve_outcome:${body.regionId}:${body.version}` });
    return sessionResponse(updated);
  } catch (error) {
    logServerEvent("preservation.failed", { request_id: requestId(request), session_id: id, phase: "preserve", duration_ms: Date.now() - started, status: "failed", error_code: error instanceof PreservationError ? error.code : "PRESERVE_EXECUTION_FAILED", provider_calls: 0, youcam_units: 0 });
    await safeRecordProductEvent(request, { eventName: "preserve_failed", tryOnSessionId: id, category: session.category, properties: { error_code: error instanceof PreservationError && ["PRESERVE_REQUEST_INVALID", "PRESERVE_BUSY", "PRESERVE_VERSION_CONFLICT", "PRESERVE_NOT_NEEDED"].includes(error.code) ? error.code : "PRESERVE_EXECUTION_FAILED" } });
    if (error instanceof PreservationError) {
      const status = error.code === "PRESERVE_VERSION_CONFLICT" || error.code === "PRESERVE_BUSY" || error.code === "PRESERVE_NOT_NEEDED" ? 409 : 400;
      return productError(error.message, "Refresh the result and try again.", status, error.code);
    }
    return productError("DrapeProof could not finish this restoration.", "Your AI result is unchanged. Try again later.", 500, "PRESERVE_EXECUTION_FAILED");
  }
}

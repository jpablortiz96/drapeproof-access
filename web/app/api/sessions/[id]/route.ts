import { NextRequest } from "next/server";
import { normalizeImageUpload, ProductUploadError, validateRegionDefinition } from "@web/server/live";
import { enforceRateLimit, notFoundSession, ownedSession, ownerFromRequest, productError, requireMutationOrigin, sessionResponse } from "@web/server/api";
import { sessions } from "@web/server/session-context";
import type { TryOnCategory, UserProtectedRegion } from "@web/server/live";
import { productAnalytics } from "@web/server/session-context";
import { safeRecordProductEvent } from "@web/server/product-events";
import { analyticsRetentionDays } from "@drapeproof/product/production/config";
import { validateFeedback, type FeedbackReason } from "@drapeproof/product/beta/events";
import { generateSession, preserveSession, processSession } from "@web/server/session-actions";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await ownedSession(request, id);
  return session ? sessionResponse(session) : notFoundSession();
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const action = request.nextUrl.searchParams.get("action");
  if (action === "generate") return generateSession(request, { params });
  if (action === "process") return processSession(request, { params });
  if (action === "preserve") return preserveSession(request, { params });
  const originError = requireMutationOrigin(request); if (originError) return originError;
  const { id } = await params;
  const session = await ownedSession(request, id);
  if (!session) return notFoundSession();
  const kind = request.nextUrl.searchParams.get("upload");
  if (kind !== "source" && kind !== "product") return productError("This upload destination is not supported.", "Return to the try-on flow.", 404);
  const rateError = await enforceRateLimit(request, "upload", ownerFromRequest(request)); if (rateError) return rateError;
  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return productError("Choose an image to continue.", "Select a JPG, PNG, or WebP image.", 400, "FILE_REQUIRED");
  try {
    const normalized = await normalizeImageUpload({ kind, originalName: file.name, mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    const asset = await sessions().writeAsset(id, normalized.asset, normalized.bytes);
    const previous = kind === "source" ? session.sourceImage : session.productImage;
    const generated = [session.providerResult, session.preservedResult, session.passportImage, ...session.preservationAttempts.map((attempt) => attempt.resultAsset)]; const derived = [...session.derivedBlobKeys];
    if (kind === "source") { session.sourceImage = asset; session.stage = "PRODUCT"; }
    else { session.productImage = asset; session.stage = "PROTECT"; }
    session.providerResult = null; session.preservedResult = null; session.passportImage = null; session.derivedBlobKeys = [];
    session.preservationAttempts = []; session.preservationVersion = 0;
    session.provider = { state: "NOT_STARTED", product: session.category === "BAG" ? "AI Bag Virtual Try-On" : "AI Clothes Virtual Try-On", version: session.category === "BAG" ? "Bag Virtual Try-On V2.0" : "Clothes V4.0" };
    session.continuity = { state: "NOT_CHECKED", localVerificationEligible: false, reasonCodes: [], signals: [] };
    session.protectedRegionResults = []; session.finalState = "PROCESSING";
    await sessions().save(session);
    await sessions().clearPreservation(id, session.ownerId);
    await Promise.all([sessions().deleteAssets(id, [previous, ...generated]), sessions().deleteDerived(id, derived)]).catch(() => undefined);
    await safeRecordProductEvent(request, { eventName: kind === "source" ? "photo_added" : "product_added", tryOnSessionId: id, category: session.category, deduplicationKey: `${id}:${kind}_added` });
    return sessionResponse(session);
  } catch (error) {
    if (error instanceof ProductUploadError) { await safeRecordProductEvent(request, { eventName: "workflow_failed", tryOnSessionId: id, category: session.category, properties: { error_code: "UPLOAD_INVALID" } }); return productError(error.message, "Choose another image and try again.", 400, error.code); }
    return productError("The image could not be saved.", "Check your connection and try again.", 500);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const originError = requireMutationOrigin(request); if (originError) return originError;
  const { id } = await params;
  const session = await ownedSession(request, id);
  if (!session) return notFoundSession();
  const obsoleteAssets = [] as Array<typeof session.providerResult>;
  let obsoleteDerived: string[] = [];
  const body = await request.json() as { category?: TryOnCategory; protectedRegions?: UserProtectedRegion[]; faceAppearanceEnabled?: boolean; productEvent?: unknown; feedback?: { useful?: unknown; reason?: unknown; somethingElse?: unknown } };
  const clientEvents = new Set(["protect_step_viewed", "result_viewed", "passport_viewed", "passport_downloaded"]);
  if (typeof body.productEvent === "string" && clientEvents.has(body.productEvent)) {
    if (!session.qaFixture) {
      const eventName = body.productEvent as "protect_step_viewed" | "result_viewed" | "passport_viewed" | "passport_downloaded";
      await safeRecordProductEvent(request, { eventName, tryOnSessionId: session.id, category: session.category, properties: eventName === "result_viewed" ? { continuity_state: session.continuity.state } : {}, deduplicationKey: `${session.id}:${eventName}` });
      if (eventName === "result_viewed") {
        const eligible = session.protectedRegionResults.filter((region) => region.repairEligibility === "ELIGIBLE");
        if (eligible.length) await safeRecordProductEvent(request, { eventName: "preserve_offered", tryOnSessionId: session.id, category: session.category, properties: { region_count: Math.min(8, eligible.length), repair_eligibility_reason: "ELIGIBLE" }, deduplicationKey: `${session.id}:preserve_offered` });
        for (const reason of [...new Set(session.protectedRegionResults.map((region) => region.repairEligibility).filter((value): value is NonNullable<typeof value> => Boolean(value?.startsWith("BLOCKED_"))))]) await safeRecordProductEvent(request, { eventName: "preserve_blocked", tryOnSessionId: session.id, category: session.category, properties: { repair_eligibility_reason: reason }, deduplicationKey: `${session.id}:preserve_blocked:${reason}` });
      }
    }
    return sessionResponse(session);
  }
  if (body.feedback !== undefined) {
    if (session.qaFixture) return productError("Feedback is unavailable for a UI-only fixture.", "Continue reviewing the interface.", 409, "REQUEST_INVALID");
    if (!session.providerResult || session.finalState === "PROCESSING") return productError("Feedback is available after a result is ready.", "Return to your result.", 409, "REQUEST_INVALID");
    try {
      const feedback = validateFeedback({ sessionId: id, useful: body.feedback.useful as boolean, reason: body.feedback.reason as FeedbackReason | null, somethingElse: body.feedback.somethingElse as string | null });
      await productAnalytics().submitFeedback(feedback, analyticsRetentionDays());
      await safeRecordProductEvent(request, { eventName: "feedback_submitted", tryOnSessionId: id, category: session.category, properties: { helpful: feedback.useful, ...(feedback.reason ? { feedback_reason: feedback.reason } : {}) }, deduplicationKey: `${id}:feedback_submitted` });
      return sessionResponse(session, 201);
    } catch (error) { return productError(error instanceof Error ? error.message : "Feedback could not be saved.", "Review your answer and try again.", 400, "REQUEST_INVALID"); }
  }
  if (body.category !== undefined) {
    if (body.category !== "CLOTHING" && body.category !== "BAG") return productError("Choose Clothing or Bag.", "Select a product type and try again.", 400, "INVALID_CATEGORY");
    if (session.category !== body.category) {
      obsoleteAssets.push(session.providerResult, session.preservedResult, session.passportImage, ...session.preservationAttempts.map((attempt) => attempt.resultAsset)); obsoleteDerived = [...session.derivedBlobKeys];
      session.category = body.category;
      session.providerResult = null; session.preservedResult = null; session.passportImage = null; session.derivedBlobKeys = [];
      session.preservationAttempts = []; session.preservationVersion = 0;
      session.continuity = { state: "NOT_CHECKED", localVerificationEligible: false, reasonCodes: [], signals: [] };
      session.protectedRegionResults = [];
    }
    session.provider = { state: "NOT_STARTED", product: body.category === "CLOTHING" ? "AI Clothes Virtual Try-On" : "AI Bag Virtual Try-On", version: body.category === "CLOTHING" ? "Clothes V4.0" : "Bag Virtual Try-On V2.0" };
  }
  if (body.protectedRegions !== undefined) {
    if (!Array.isArray(body.protectedRegions) || body.protectedRegions.length > 8) return productError("Add no more than eight protected areas.", "Remove an area and try again.", 400, "INVALID_REGIONS");
    if (body.protectedRegions.length) {
      try { session.protectedRegions = validateRegionDefinition({ schema_version: "1.0", coordinate_space: "normalized", regions: body.protectedRegions }).regions; }
      catch (error) { return productError(error instanceof Error ? error.message : "A protected area is invalid.", "Edit the area and try again.", 400, "INVALID_REGIONS"); }
    } else session.protectedRegions = [];
    session.stage = "REVIEW";
  }
  if (body.faceAppearanceEnabled !== undefined) session.faceAppearance = { enabled: body.faceAppearanceEnabled, state: "NOT_CHECKED" };
  await sessions().save(session);
  if (body.category !== undefined) await sessions().clearPreservation(id, session.ownerId);
  await Promise.all([sessions().deleteAssets(id, obsoleteAssets), sessions().deleteDerived(id, obsoleteDerived)]).catch(() => undefined);
  if (body.protectedRegions !== undefined) await safeRecordProductEvent(request, {
    eventName: session.protectedRegions.length ? "protected_region_added" : "protect_skipped",
    tryOnSessionId: id, category: session.category, properties: { region_count: session.protectedRegions.length },
    deduplicationKey: `${id}:${session.protectedRegions.length ? "protected" : "skipped"}:${session.protectedRegions.length}`,
  });
  return sessionResponse(session);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const originError = requireMutationOrigin(request); if (originError) return originError;
  const { id } = await params;
  const owner = ownerFromRequest(request);
  const existing = owner ? await sessions().getOwned(id, owner) : null;
  if (!owner || !existing || !await sessions().delete(id, owner)) return notFoundSession();
  await productAnalytics().deleteFeedback(id).catch(() => undefined);
  if (!existing.qaFixture) await safeRecordProductEvent(request, { eventName: "session_deleted", tryOnSessionId: id, deduplicationKey: `${id}:session_deleted` });
  return new Response(null, { status: 204 });
}

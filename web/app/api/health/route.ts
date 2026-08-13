import { NextRequest, NextResponse } from "next/server";
import { publicSession } from "@web/server/live";
import { enforceRateLimit, ownerFromRequest, privateHeaders, productError, requireMutationOrigin } from "@web/server/api";
import { safeRecordProductEvent } from "@web/server/product-events";
import { logServerEvent } from "@drapeproof/product/production/logging";
import { OWNER_COOKIE, cookieOptions, newOwnerId, ownerHash, sessions } from "@web/server/session-context";
import { isAnonymousToken } from "@drapeproof/product/production/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("view") === "sessions") {
    const owner = ownerFromRequest(request);
    if (!owner) return NextResponse.json({ sessions: [] }, { headers: privateHeaders() });
    const records = await sessions().list(owner);
    return NextResponse.json({ sessions: records.map(publicSession) }, { headers: privateHeaders() });
  }
  const started = Date.now();
  try {
    const dependencies = await sessions().health();
    const ready = dependencies.database && dependencies.storage;
    logServerEvent("health.completed", {
      phase: "health",
      duration_ms: Date.now() - started,
      status: ready ? "ok" : "degraded",
      database: dependencies.database ? "ok" : "unavailable",
      storage: dependencies.storage ? "ok" : "unavailable",
    });
    return NextResponse.json({ status: ready ? "ok" : "degraded", app: "ok", database: dependencies.database ? "ok" : "unavailable", storage: dependencies.storage ? "ok" : "unavailable" }, {
      status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logServerEvent("health.failed", {
      phase: "health",
      duration_ms: Date.now() - started,
      status: "error",
      error_code: "HEALTH_CHECK_FAILED",
      error,
    });
    return NextResponse.json({ status: "degraded", app: "ok", database: "unavailable", storage: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: NextRequest) {
  const originError = requireMutationOrigin(request); if (originError) return originError;
  let body: { productEvent?: unknown; action?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { /* ignore invalid analytics beacon */ }
  if (body.action === "create_session") {
    const currentToken = request.cookies.get(OWNER_COOKIE)?.value;
    const token = isAnonymousToken(currentToken) ? currentToken : newOwnerId();
    const owner = ownerHash(token);
    const rateError = await enforceRateLimit(request, "session-create", isAnonymousToken(currentToken) ? owner : null); if (rateError) return rateError;
    try {
      const session = await sessions().create(owner);
      await safeRecordProductEvent(request, { eventName: "try_started", tryOnSessionId: session.id, deduplicationKey: `${session.id}:try_started` });
      const response = NextResponse.json({ session: publicSession(session) }, { status: 201, headers: privateHeaders() });
      if (!isAnonymousToken(currentToken)) response.cookies.set(OWNER_COOKIE, token, cookieOptions());
      return response;
    } catch { return productError("A new try-on could not be started.", "Try again in a moment.", 503, "DATABASE_FAILURE"); }
  }
  if (body.productEvent === "landing_viewed") await safeRecordProductEvent(request, { eventName: "landing_viewed" });
  return NextResponse.json({ ok: true }, { headers: privateHeaders() });
}

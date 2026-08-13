import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { logServerEvent } from "@drapeproof/product/production/logging";
import { sessions } from "@web/server/session-context";
import { productAnalytics } from "@web/server/session-context";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const actual = request.headers.get("authorization");
  if (!actual) return false;
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const left = Buffer.from(actual); const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return new NextResponse(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  const started = Date.now(); const startedAt = new Date().toISOString();
  try {
    const summary = await sessions().cleanupExpired();
    const analytics = await productAnalytics().cleanupExpired();
    const status = summary.failed === 0 ? "SUCCESS" : "FAILED";
    await productAnalytics().recordCleanupRun({ startedAt, completedAt: new Date().toISOString(), status, sessions: summary, ...analytics, errorCode: summary.failed ? "CLEANUP_RETRY_REQUIRED" : null });
    logServerEvent("cleanup.completed", { phase: "cleanup", duration_ms: Date.now() - started, status: status.toLowerCase(), ...summary, ...analytics });
    return NextResponse.json({ ok: status === "SUCCESS", ...summary, ...analytics }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await productAnalytics().recordCleanupRun({ startedAt, completedAt: new Date().toISOString(), status: "FAILED", sessions: { examined: 0, cleaned: 0, failed: 1 }, eventsDeleted: 0, feedbackDeleted: 0, errorCode: "CLEANUP_FAILED" }).catch(() => undefined);
    logServerEvent("cleanup.failed", { phase: "cleanup", duration_ms: Date.now() - started, status: "error", error_code: "CLEANUP_FAILED", error });
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

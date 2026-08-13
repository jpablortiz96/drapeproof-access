import "server-only";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { rateLimitConfig, usesProductionPersistence } from "@drapeproof/product/production/config";
import { logServerEvent } from "@drapeproof/product/production/logging";
import { hashRateLimitKey, isAnonymousToken } from "@drapeproof/product/production/ownership";
import type { RateLimitScope } from "@drapeproof/product/production/rate-limit";
import { mutationOriginAllowed } from "@drapeproof/product/production/request-security";
import { publicSession, type TryOnSession } from "./live";
import { OWNER_COOKIE, ownerHash, rateLimiter, sessions } from "./session-context";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "X-Robots-Tag": "noindex, nofollow, noarchive" };

export function requestId(request: NextRequest): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || request.headers.get("x-vercel-id")?.slice(0, 128) || randomUUID();
}

export function ownerFromRequest(request: NextRequest): string | null {
  const token = request.cookies.get(OWNER_COOKIE)?.value;
  return isAnonymousToken(token) ? ownerHash(token) : null;
}

export async function ownedSession(request: NextRequest, id: string): Promise<TryOnSession | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  const owner = ownerFromRequest(request);
  return owner ? sessions().getOwned(id, owner) : null;
}

export function sessionResponse(session: TryOnSession, status = 200): NextResponse {
  return NextResponse.json({ session: publicSession(session) }, { status, headers: NO_STORE });
}

export function productError(message: string, action: string, status = 400, code = "REQUEST_INVALID", retryAfter?: number): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return NextResponse.json({ error: { code, message, action } }, { status, headers });
}

export function notFoundSession(): NextResponse {
  return productError("This try-on session is no longer available.", "Start a new try-on.", 404, "SESSION_NOT_FOUND");
}

export function requireMutationOrigin(request: NextRequest): NextResponse | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host).split(",", 1)[0]!.trim();
  return mutationOriginAllowed({ origin, host, fetchSite, production: usesProductionPersistence() })
    ? null
    : productError("This request could not be verified.", "Refresh the page and try again.", 403, "ORIGIN_REJECTED");
}

function limitFor(scope: RateLimitScope): { limit: number; window: number } {
  const config = rateLimitConfig();
  if (scope === "session-create") return { limit: config.sessionCreatePerHour, window: 3_600 };
  if (scope === "upload") return { limit: config.uploadsPerTenMinutes, window: 600 };
  if (scope === "generation") return { limit: config.generationsPerHour, window: 3_600 };
  if (scope === "preserve") return { limit: config.preservesPerTenMinutes, window: 600 };
  return { limit: config.statusPerTenMinutes, window: 600 };
}

export async function enforceRateLimit(request: NextRequest, scope: RateLimitScope, owner: string | null): Promise<NextResponse | null> {
  const wafId = process.env[`DRAPEPROOF_WAF_${scope.replaceAll("-", "_").toUpperCase()}_ID`];
  if (wafId && process.env.VERCEL_ENV === "production") {
    try {
      const { checkRateLimit } = await import("@vercel/firewall");
      if ((await checkRateLimit(wafId, { request })).rateLimited) return productError("Too many try-ons right now. Please try again in a little while.", "Wait a little while, then try again.", 429, "RATE_LIMITED", 60);
    } catch (error) { logServerEvent("rate_limit.waf_unavailable", { request_id: requestId(request), phase: scope, error_code: "WAF_UNAVAILABLE", error }); }
  }
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ?? "unknown";
  const secret = process.env.DRAPEPROOF_OWNER_HASH_SECRET ?? "drapeproof-local-rate-limit";
  const key = hashRateLimitKey(owner ? `owner:${owner}` : `ip:${forwarded}`, secret);
  const { limit, window } = limitFor(scope);
  const decision = await rateLimiter().check(scope, key, limit, window);
  return decision.allowed ? null : productError("Too many try-ons right now. Please try again in a little while.", "Wait a little while, then try again.", 429, "RATE_LIMITED", decision.retryAfterSeconds);
}

export function privateHeaders(extra: Record<string, string> = {}): HeadersInit { return { ...NO_STORE, ...extra }; }

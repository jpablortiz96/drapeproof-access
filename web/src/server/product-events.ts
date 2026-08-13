import "server-only";
import type { NextRequest } from "next/server";
import { analyticsRetentionDays } from "@drapeproof/product/production/config";
import { anonymousEventBucket, type ProductEventInput } from "@drapeproof/product/beta/events";
import { logServerEvent } from "@drapeproof/product/production/logging";
import { isAnonymousToken } from "@drapeproof/product/production/ownership";
import { OWNER_COOKIE, ownerHash, productAnalytics } from "./session-context";

export async function safeRecordProductEvent(request: NextRequest, input: Omit<ProductEventInput, "anonymousSessionBucket">): Promise<void> {
  if (request.cookies.get("dp_qa")?.value === "1") return;
  try {
    const token = request.cookies.get(OWNER_COOKIE)?.value;
    const bucket = isAnonymousToken(token)
      ? anonymousEventBucket(ownerHash(token), process.env.DRAPEPROOF_OWNER_HASH_SECRET ?? "drapeproof-local-events")
      : null;
    await productAnalytics().record({ ...input, anonymousSessionBucket: bucket }, analyticsRetentionDays());
  } catch (error) {
    logServerEvent("analytics.event_rejected", { phase: "product-analytics", error_code: "ANALYTICS_EVENT_REJECTED", error });
  }
}

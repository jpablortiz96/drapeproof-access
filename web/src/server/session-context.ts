import "server-only";
import { cookies } from "next/headers";
import type { TryOnSession } from "@drapeproof/product/live/types";
import type { SessionRepository } from "@drapeproof/product/live/repository";
import { FileSessionRepository, defaultSessionRoot } from "./live";
import { VercelPrivateObjectStore } from "@drapeproof/product/production/blob";
import { loadProductionConfig, sessionTtlHours, usesProductionPersistence } from "@drapeproof/product/production/config";
import { NeonDatabaseClient } from "@drapeproof/product/production/db";
import { hashAnonymousToken, isAnonymousToken, newAnonymousToken } from "@drapeproof/product/production/ownership";
import { MemoryRateLimiter, PostgresRateLimiter, type RateLimiter } from "@drapeproof/product/production/rate-limit";
import { PostgresBlobSessionRepository } from "@drapeproof/product/production/repository";
import { MemoryProviderBudgetGuard, PostgresProviderBudgetGuard, type ProviderBudgetGuard } from "@drapeproof/product/beta/budget";
import { MemoryProductAnalyticsStore, PostgresProductAnalyticsStore, type ProductAnalyticsStore } from "@drapeproof/product/beta/events";

export const OWNER_COOKIE = "dp_anon";
let repository: SessionRepository | undefined;
let limiter: RateLimiter | undefined;
let budgetGuard: ProviderBudgetGuard | undefined;
let analyticsStore: ProductAnalyticsStore | undefined;

function productionResources(): { repository: SessionRepository; limiter: RateLimiter; budget: ProviderBudgetGuard; analytics: ProductAnalyticsStore } {
  const config = loadProductionConfig();
  const database = new NeonDatabaseClient(config.databaseUrl);
  const objects = new VercelPrivateObjectStore(config.blobToken);
  return {
    repository: new PostgresBlobSessionRepository(database, objects, config.sessionTtlHours),
    limiter: new PostgresRateLimiter(database),
    budget: new PostgresProviderBudgetGuard(database),
    analytics: new PostgresProductAnalyticsStore(database),
  };
}

function ensureResources(): void {
  if (repository && limiter && budgetGuard && analyticsStore) return;
  if (usesProductionPersistence()) {
    const resources = productionResources(); repository = resources.repository; limiter = resources.limiter; budgetGuard = resources.budget; analyticsStore = resources.analytics;
  } else {
    repository = new FileSessionRepository(defaultSessionRoot(), sessionTtlHours()); limiter = new MemoryRateLimiter(); budgetGuard = new MemoryProviderBudgetGuard(); analyticsStore = new MemoryProductAnalyticsStore();
  }
}

export function sessions(): SessionRepository { ensureResources(); return repository!; }
export function rateLimiter(): RateLimiter { ensureResources(); return limiter!; }
export function providerBudget(): ProviderBudgetGuard { ensureResources(); return budgetGuard!; }
export function productAnalytics(): ProductAnalyticsStore { ensureResources(); return analyticsStore!; }
export function newOwnerId(): string { return newAnonymousToken(); }

export function ownerHash(token: string): string {
  if (!isAnonymousToken(token)) throw new Error("Anonymous ownership token is malformed.");
  const secret = usesProductionPersistence() ? loadProductionConfig().ownerHashSecret : undefined;
  return hashAnonymousToken(token, secret);
}

export async function ownerFromPage(): Promise<string | null> {
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  return isAnonymousToken(token) ? ownerHash(token) : null;
}

export async function ownedSessionFromPage(id: string): Promise<TryOnSession | null> {
  const owner = await ownerFromPage();
  return owner ? sessions().getOwned(id, owner) : null;
}

export function cookieOptions() {
  return {
    httpOnly: true, sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 60 * 60 * 24 * 30,
  };
}

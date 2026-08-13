import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryProviderBudgetGuard } from "../src/product/beta/budget.js";
import { MemoryProductAnalyticsStore, PRODUCT_EVENT_NAMES, anonymousEventBucket, validateFeedback, validateProductEvent } from "../src/product/beta/events.js";
import { FileSessionRepository } from "../src/product/live/repository.js";
import { GenerationControlError, startLiveGeneration } from "../src/product/live/pipeline.js";
import { ProviderSubmissionError, type LiveGenerationProvider } from "../src/product/live/provider.js";
import type { TryOnSession } from "../src/product/live/types.js";
import { normalizeImageUpload } from "../src/product/live/uploads.js";
import { generationEnabled, providerDailyUnitBudget, providerOperationUnits } from "../src/product/production/config.js";
import { normalizeAnalyticsUrl } from "../web/src/lib/analytics-url.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function readySession(): Promise<{ repository: FileSessionRepository; session: TryOnSession }> {
  const root = await mkdtemp(join(tmpdir(), "drapeproof-beta-")); roots.push(root);
  const repository = new FileSessionRepository(root); const session = await repository.create("owner");
  const [source, product] = await Promise.all([
    normalizeImageUpload({ kind: "source", originalName: "person.png", mediaType: "image/png", bytes: await readFile(resolve("web/public/product/sample-original.png")) }),
    normalizeImageUpload({ kind: "product", originalName: "garment.png", mediaType: "image/png", bytes: await readFile(resolve("web/public/product/sample-garment.png")) }),
  ]);
  session.category = "CLOTHING"; session.sourceImage = await repository.writeAsset(session.id, source.asset, source.bytes); session.productImage = await repository.writeAsset(session.id, product.asset, product.bytes); await repository.save(session);
  return { repository, session };
}

function provider(onStart: () => void, error?: Error): LiveGenerationProvider {
  return { async start() { onStart(); await new Promise((done) => setTimeout(done, 20)); if (error) throw error; return { taskId: "provider-task", product: "AI Clothes Virtual Try-On", version: "Clothes V4.0" }; }, async poll() { return { state: "RUNNING" }; } };
}

describe("global provider budget and kill switch", () => {
  it("atomically exhausts a global UTC-day budget under concurrent reservations", async () => {
    const guard = new MemoryProviderBudgetGuard();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => guard.reserve({ reservationKey: `r-${index}`, sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, category: "CLOTHING", expectedUnits: 2, budget: 10, utcDay: "2026-08-13" })));
    expect(results.filter((item) => item.decision === "AVAILABLE")).toHaveLength(5);
    expect(results.filter((item) => item.decision === "BUDGET_EXHAUSTED")).toHaveLength(7);
    expect(await guard.status(10, "2026-08-13")).toMatchObject({ reservedUnits: 10, remainingUnits: 0 });
  });

  it("does not double-reserve duplicate generation identities", async () => {
    const guard = new MemoryProviderBudgetGuard(); const input = { reservationKey: "same", sessionId: "00000000-0000-4000-8000-000000000001", category: "CLOTHING" as const, expectedUnits: 2, budget: 10, utcDay: "2026-08-13" };
    const decisions = await Promise.all([guard.reserve(input), guard.reserve(input)]);
    expect(decisions.map((item) => item.decision).sort()).toEqual(["AVAILABLE", "DUPLICATE"]);
    expect((await guard.status(10, "2026-08-13")).reservedUnits).toBe(2);
  });

  it("blocks disabled generation before any provider call", async () => {
    const { repository, session } = await readySession(); const guard = new MemoryProviderBudgetGuard(); let calls = 0;
    await expect(startLiveGeneration(session, repository, provider(() => { calls += 1; }), "disabled", { enabled: false, budget: 10, expectedUnits: 2, guard })).rejects.toMatchObject({ controlCode: "GENERATION_PAUSED" });
    expect(calls).toBe(0); expect((await guard.status(10)).reservedUnits).toBe(0);
  });

  it("blocks an exhausted budget before any provider call", async () => {
    const { repository, session } = await readySession(); const guard = new MemoryProviderBudgetGuard(); let calls = 0;
    await guard.reserve({ reservationKey: "existing", sessionId: session.id, category: "CLOTHING", expectedUnits: 2, budget: 2 });
    await expect(startLiveGeneration(session, repository, provider(() => { calls += 1; }), "new", { enabled: true, budget: 2, expectedUnits: 2, guard })).rejects.toBeInstanceOf(GenerationControlError);
    expect(calls).toBe(0); expect((await guard.status(2)).reservedUnits).toBe(2);
  });

  it("keeps generation and reservation idempotent under duplicate requests", async () => {
    const { repository, session } = await readySession(); const first = (await repository.get(session.id))!; const second = (await repository.get(session.id))!; const guard = new MemoryProviderBudgetGuard(); let calls = 0;
    await Promise.all([first, second].map((record) => startLiveGeneration(record, repository, provider(() => { calls += 1; }), "same-attempt", { enabled: true, budget: 10, expectedUnits: 2, guard })));
    expect(calls).toBe(1); expect((await guard.status(10)).reservedUnits).toBe(2);
  });

  it("releases only definite pre-accept failures and retains uncertain spend", async () => {
    const definite = await readySession(); const definiteGuard = new MemoryProviderBudgetGuard();
    await startLiveGeneration(definite.session, definite.repository, provider(() => undefined, new ProviderSubmissionError("rejected", true)), "definite", { enabled: true, budget: 10, expectedUnits: 2, guard: definiteGuard });
    expect((await definiteGuard.status(10)).reservedUnits).toBe(0);
    const uncertain = await readySession(); const uncertainGuard = new MemoryProviderBudgetGuard();
    await startLiveGeneration(uncertain.session, uncertain.repository, provider(() => undefined, new ProviderSubmissionError("unknown", false)), "uncertain", { enabled: true, budget: 10, expectedUnits: 2, guard: uncertainGuard });
    expect((await uncertainGuard.status(10)).reservedUnits).toBe(2);
  });

  it("uses safe production defaults and explicit overrides", () => {
    expect(generationEnabled({ VERCEL_ENV: "production" })).toBe(false);
    expect(generationEnabled({ VERCEL_ENV: "production", DRAPEPROOF_GENERATION_ENABLED: "true" })).toBe(true);
    expect(providerDailyUnitBudget({})).toBe(10); expect(providerOperationUnits("CLOTHING", {})).toBe(2); expect(providerOperationUnits("BAG", {})).toBe(2);
  });
});

describe("privacy-minimized events, feedback, reports, and retention", () => {
  it("enforces the event allowlist and rejects coordinates, URLs, tokens, and unknown data", () => {
    expect(PRODUCT_EVENT_NAMES).toContain("feedback_submitted");
    expect(validateProductEvent({ eventName: "protected_region_added", properties: { region_count: 3 } }).properties).toEqual({ region_count: 3 });
    expect(() => validateProductEvent({ eventName: "protected_region_added", properties: { coordinates: [[0.1, 0.2]] } })).toThrow(/not allowed/);
    expect(() => validateProductEvent({ eventName: "result_viewed", properties: { image_url: "https://private.example/a" } })).toThrow(/not allowed/);
    expect(() => validateProductEvent({ eventName: "result_viewed", properties: { owner_token: "secret" } })).toThrow(/not allowed/);
    expect(() => validateProductEvent({ eventName: "not_real" as never })).toThrow(/allowlisted/);
  });

  it("creates a rotating, non-reversible anonymous bucket", () => {
    const first = anonymousEventBucket("owner-hash", "secret", new Date("2026-08-13T10:00:00Z")); const next = anonymousEventBucket("owner-hash", "secret", new Date("2026-08-14T00:00:01Z"));
    expect(first).toMatch(/^[a-f0-9]{32}$/); expect(first).not.toContain("owner-hash"); expect(first).not.toBe(next);
  });

  it("validates optional short feedback and deletes linked feedback", async () => {
    const id = "00000000-0000-4000-8000-000000000001"; const store = new MemoryProductAnalyticsStore();
    expect(validateFeedback({ sessionId: id, useful: false, reason: "REUSE_PROTECTED_AREAS" })).toMatchObject({ useful: false, reason: "REUSE_PROTECTED_AREAS" });
    expect(() => validateFeedback({ sessionId: id, useful: false, reason: "SOMETHING_ELSE", somethingElse: "x".repeat(241) })).toThrow(/240/);
    expect(() => validateFeedback({ sessionId: id, useful: true, reason: "TOO_SLOW", somethingElse: "not allowed" })).toThrow(/Something else/);
    await store.submitFeedback({ sessionId: id, useful: true }, 30); expect(store.feedback.has(id)).toBe(true); await store.deleteFeedback(id); expect(store.feedback.has(id)).toBe(false);
  });

  it("expires analytics and feedback without touching session retention", async () => {
    const id = "00000000-0000-4000-8000-000000000002"; const store = new MemoryProductAnalyticsStore();
    await store.record({ eventName: "try_started", tryOnSessionId: id, occurredAt: "2020-01-01T00:00:00.000Z" }, 1);
    await store.submitFeedback({ sessionId: id, useful: true }, 30); store.feedback.get(id)!.expiresAt = "2020-01-01T00:00:00.000Z";
    expect(await store.cleanupExpired()).toEqual({ eventsDeleted: 1, feedbackDeleted: 1 });
  });

  it("builds only aggregate beta report and status data", async () => {
    const store = new MemoryProductAnalyticsStore(); const start = "2026-08-01T00:00:00.000Z"; const end = "2026-09-01T00:00:00.000Z";
    for (const eventName of ["try_started", "photo_added", "product_added", "generation_started", "provider_succeeded", "result_viewed", "passport_viewed"] as const) await store.record({ eventName, occurredAt: "2026-08-13T12:00:00.000Z" }, 30);
    await store.record({ eventName: "provider_failed", properties: { error_code: "PROVIDER_TIMEOUT" }, occurredAt: "2026-08-13T12:01:00.000Z" }, 30);
    await store.record({ eventName: "preserve_blocked", properties: { repair_eligibility_reason: "BLOCKED_TRANSFORM_OVERLAP" }, occurredAt: "2026-08-13T12:02:00.000Z" }, 30);
    const report = await store.betaReport({ start, end, budget: 10 });
    expect(report.funnel.at(-1)).toMatchObject({ event: "passport_viewed", count: 1, ratioFromPrevious: 1 });
    expect(report.failureCodeCounts).toEqual({ PROVIDER_TIMEOUT: 1 }); expect(report.repairBlockReasonCounts).toEqual({ BLOCKED_TRANSFORM_OVERLAP: 1 });
    expect(JSON.stringify(report)).not.toMatch(/sessionId|owner|coordinates|image/i);
    expect(await store.betaStatus({ generationEnabled: true, budget: 10, utcDay: "2026-08-13" })).toMatchObject({ generationEnabled: true, sessionsCreatedToday: 1, providerSucceededToday: 1, providerFailedToday: 1 });
  });
});

describe("public beta UI, telemetry, and schema contracts", () => {
  it("normalizes dynamic page identifiers and strips query parameters", () => {
    expect(normalizeAnalyticsUrl("https://drapeproof-access.vercel.app/result/00000000-0000-4000-8000-000000000001?token=private")).toBe("https://drapeproof-access.vercel.app/result/[id]");
    expect(normalizeAnalyticsUrl("/try/photo?session=00000000-0000-4000-8000-000000000001")).toBe("/try/photo");
    expect(normalizeAnalyticsUrl("/passport/00000000-0000-4000-8000-000000000001")).toBe("/passport/[id]");
  });

  it("ships responsive and accessible beta, feedback, paused, and budget states", async () => {
    const [shell, runtime, feedback, review, css, telemetry] = await Promise.all(["web/src/components/product/ui.tsx", "web/src/components/product/beta-runtime.tsx", "web/src/components/product/feedback-panel.tsx", "web/src/components/product/review-step.tsx", "web/app/product.css", "web/src/components/product/telemetry.tsx"].map((path) => readFile(resolve(path), "utf8")));
    expect(shell).toMatch(/beta-badge.*Beta/); expect(runtime).toContain("AI previews can be imperfect");
    expect(feedback).toMatch(/Was DrapeProof useful\?|Not really|REUSE_PROTECTED_AREAS|maxLength={240}|aria-pressed/);
    expect(review).toMatch(/Try-ons are temporarily full for today|New try-ons are temporarily paused|Back to home/);
    expect(css).toMatch(/feedback-card|beta-upload-note|@media \(max-width: 600px\)|min-height: 48px/);
    expect(telemetry).toMatch(/@vercel\/analytics\/next|@vercel\/speed-insights\/next|normalizeAnalyticsUrl/);
  });

  it("uses database locking, durable reservations, append-only events, and retention indexes", async () => {
    const migration = await readFile(resolve("migrations/0003_m9_beta_control_plane.sql"), "utf8");
    expect(migration).toMatch(/pg_advisory_xact_lock|provider_unit_reservations|reservation_key text PRIMARY KEY|BUDGET_EXHAUSTED|drapeproof_release_provider_units/);
    expect(migration).toMatch(/product_events|beta_feedback|expires_at|ON DELETE CASCADE|beta_cleanup_runs/);
  });
});

import { createHmac, randomUUID } from "node:crypto";
import type { TryOnCategory } from "../live/types.js";
import type { CleanupSummary } from "../live/repository.js";
import type { DatabaseClient } from "../production/db.js";
import type { ProviderBudgetStatus } from "./budget.js";

export const PRODUCT_EVENT_NAMES = [
  "landing_viewed", "try_started", "photo_added", "product_added", "protect_step_viewed",
  "protected_region_added", "protect_skipped", "review_confirmed", "generation_started",
  "provider_succeeded", "provider_failed", "continuity_passed", "continuity_failed", "result_viewed",
  "preserve_offered", "preserve_blocked", "preserve_started", "preserve_restored", "preserve_review",
  "preserve_failed", "passport_viewed", "passport_downloaded", "session_deleted", "feedback_submitted",
  "workflow_failed",
] as const;

export type ProductEventName = typeof PRODUCT_EVENT_NAMES[number];
export type FeedbackReason = "TRY_ON_UNREALISTIC" | "PROTECTED_AREAS_UNCLEAR" | "RESTORE_MORE" | "TOO_SLOW" | "REUSE_PROTECTED_AREAS" | "SOMETHING_ELSE";

const feedbackReasons = new Set<FeedbackReason>([
  "TRY_ON_UNREALISTIC", "PROTECTED_AREAS_UNCLEAR", "RESTORE_MORE", "TOO_SLOW", "REUSE_PROTECTED_AREAS", "SOMETHING_ELSE",
]);
const eventNames = new Set<string>(PRODUCT_EVENT_NAMES);
const continuityStates = new Set(["CONSISTENT", "NEEDS_REVIEW", "CHANGED_TOO_MUCH", "UNAVAILABLE"]);
const durationBuckets = new Set(["LT_10S", "10_30S", "30_60S", "1_3M", "GT_3M"]);
const errorCodes = new Set([
  "UPLOAD_INVALID", "PROVIDER_REJECTED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "CONTINUITY_FAILED",
  "VERIFICATION_FAILURE", "PRESERVE_EXECUTION_FAILED", "PRESERVE_REQUEST_INVALID", "PRESERVE_BUSY",
  "PRESERVE_VERSION_CONFLICT", "PRESERVE_NOT_NEEDED",
]);
const repairReasons = new Set([
  "ELIGIBLE", "BLOCKED_CONTINUITY", "BLOCKED_ALIGNMENT", "BLOCKED_TRANSFORM_OVERLAP",
  "BLOCKED_TRANSFORM_PROXIMITY", "BLOCKED_INSUFFICIENT_CONTEXT", "NOT_NEEDED",
]);
const repairOutcomes = new Set(["RESTORED", "IMPROVED_BUT_REVIEW", "UNCHANGED", "FAILED", "BLOCKED"]);

type SafeProperty = string | number | boolean;

export interface ProductEventInput {
  eventName: ProductEventName;
  anonymousSessionBucket?: string | null;
  tryOnSessionId?: string | null;
  category?: TryOnCategory | null;
  properties?: Record<string, unknown>;
  deduplicationKey?: string | null;
  occurredAt?: string;
}

export interface StoredProductEvent {
  id: string;
  occurredAt: string;
  eventName: ProductEventName;
  anonymousSessionBucket: string | null;
  tryOnSessionId: string | null;
  category: TryOnCategory | null;
  properties: Record<string, SafeProperty>;
  deduplicationKey: string | null;
  expiresAt: string;
}

export interface FeedbackInput {
  sessionId: string;
  useful: boolean;
  reason?: FeedbackReason | null;
  somethingElse?: string | null;
}

export interface AnalyticsCleanupSummary { eventsDeleted: number; feedbackDeleted: number }
export interface CleanupRunInput extends AnalyticsCleanupSummary { startedAt: string; completedAt: string; status: "SUCCESS" | "FAILED"; sessions: CleanupSummary; errorCode?: string | null }

export interface BetaReport {
  period: { start: string; end: string };
  counts: Record<ProductEventName, number>;
  funnel: Array<{ event: ProductEventName; count: number; ratioFromPrevious: number | null }>;
  protect: { protectedAtLeastOne: number; skipped: number };
  preserve: { offered: number; started: number; restored: number; startRate: number | null; restoreRate: number | null };
  provider: { semanticTaskCount: number; estimatedUnitsReserved: number; budget: ProviderBudgetStatus };
  failureCodeCounts: Record<string, number>;
  repairBlockReasonCounts: Record<string, number>;
}

export interface BetaStatus {
  generationEnabled: boolean;
  budget: ProviderBudgetStatus;
  sessionsCreatedToday: number;
  providerSucceededToday: number;
  providerFailedToday: number;
  latestCleanup: { completedAt: string; status: "SUCCESS" | "FAILED"; sessionsCleaned: number; eventsDeleted: number; feedbackDeleted: number; errorCode: string | null } | null;
}

export interface ProductAnalyticsStore {
  record(input: ProductEventInput, retentionDays: number): Promise<boolean>;
  submitFeedback(input: FeedbackInput, retentionDays: number): Promise<void>;
  deleteFeedback(sessionId: string): Promise<void>;
  cleanupExpired(): Promise<AnalyticsCleanupSummary>;
  recordCleanupRun(input: CleanupRunInput): Promise<void>;
  betaReport(input: { start: string; end: string; budget: number }): Promise<BetaReport>;
  betaStatus(input: { generationEnabled: boolean; budget: number; utcDay?: string }): Promise<BetaStatus>;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function allowedProperties(eventName: ProductEventName, raw: Record<string, unknown>): Record<string, SafeProperty> {
  const output: Record<string, SafeProperty> = {};
  const allowed = new Set<string>();
  if (["protected_region_added", "protect_skipped", "review_confirmed", "preserve_offered"].includes(eventName)) allowed.add("region_count");
  if (["provider_succeeded", "provider_failed", "continuity_passed", "continuity_failed"].includes(eventName)) allowed.add("duration_bucket");
  if (["provider_failed", "continuity_failed", "preserve_failed", "workflow_failed"].includes(eventName)) allowed.add("error_code");
  if (["continuity_passed", "continuity_failed", "result_viewed"].includes(eventName)) allowed.add("continuity_state");
  if (["preserve_offered", "preserve_blocked", "preserve_started"].includes(eventName)) allowed.add("repair_eligibility_reason");
  if (["preserve_restored", "preserve_review"].includes(eventName)) allowed.add("repair_outcome");
  if (eventName === "feedback_submitted") { allowed.add("helpful"); allowed.add("feedback_reason"); }
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Analytics property ${key} is not allowed for ${eventName}.`);
  if (raw.region_count !== undefined) { const value = integer(raw.region_count, 0, 8); if (value === null) throw new Error("region_count is invalid."); output.region_count = value; }
  if (raw.duration_bucket !== undefined) { if (typeof raw.duration_bucket !== "string" || !durationBuckets.has(raw.duration_bucket)) throw new Error("duration_bucket is invalid."); output.duration_bucket = raw.duration_bucket; }
  if (raw.error_code !== undefined) { if (typeof raw.error_code !== "string" || !errorCodes.has(raw.error_code)) throw new Error("error_code is invalid."); output.error_code = raw.error_code; }
  if (raw.continuity_state !== undefined) { if (typeof raw.continuity_state !== "string" || !continuityStates.has(raw.continuity_state)) throw new Error("continuity_state is invalid."); output.continuity_state = raw.continuity_state; }
  if (raw.repair_eligibility_reason !== undefined) { if (typeof raw.repair_eligibility_reason !== "string" || !repairReasons.has(raw.repair_eligibility_reason)) throw new Error("repair_eligibility_reason is invalid."); output.repair_eligibility_reason = raw.repair_eligibility_reason; }
  if (raw.repair_outcome !== undefined) { if (typeof raw.repair_outcome !== "string" || !repairOutcomes.has(raw.repair_outcome)) throw new Error("repair_outcome is invalid."); output.repair_outcome = raw.repair_outcome; }
  if (raw.helpful !== undefined) { if (typeof raw.helpful !== "boolean") throw new Error("helpful is invalid."); output.helpful = raw.helpful; }
  if (raw.feedback_reason !== undefined) { if (typeof raw.feedback_reason !== "string" || !feedbackReasons.has(raw.feedback_reason as FeedbackReason)) throw new Error("feedback_reason is invalid."); output.feedback_reason = raw.feedback_reason; }
  return output;
}

export function validateProductEvent(input: ProductEventInput): Omit<StoredProductEvent, "id" | "expiresAt"> {
  if (!eventNames.has(input.eventName)) throw new Error("Product event is not allowlisted.");
  if (input.tryOnSessionId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.tryOnSessionId)) throw new Error("Product event session identifier is invalid.");
  if (input.anonymousSessionBucket != null && !/^[a-f0-9]{32}$/.test(input.anonymousSessionBucket)) throw new Error("Anonymous event bucket is invalid.");
  if (input.category != null && input.category !== "CLOTHING" && input.category !== "BAG") throw new Error("Product event category is invalid.");
  if (input.deduplicationKey != null && (!/^[A-Za-z0-9:_-]{1,180}$/.test(input.deduplicationKey))) throw new Error("Product event deduplication key is invalid.");
  return {
    occurredAt: input.occurredAt ?? new Date().toISOString(), eventName: input.eventName,
    anonymousSessionBucket: input.anonymousSessionBucket ?? null, tryOnSessionId: input.tryOnSessionId ?? null,
    category: input.category ?? null, properties: allowedProperties(input.eventName, input.properties ?? {}),
    deduplicationKey: input.deduplicationKey ?? null,
  };
}

export function validateFeedback(input: FeedbackInput): Required<FeedbackInput> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sessionId)) throw new Error("Feedback session identifier is invalid.");
  if (typeof input.useful !== "boolean") throw new Error("Choose Yes or Not really.");
  const reason = input.reason ?? null;
  if (reason !== null && !feedbackReasons.has(reason)) throw new Error("Choose a feedback reason from the list.");
  const somethingElse = input.somethingElse?.trim() || null;
  if (somethingElse && reason !== "SOMETHING_ELSE") throw new Error("Written feedback is available only for Something else.");
  if (somethingElse && somethingElse.length > 240) throw new Error("Written feedback must be 240 characters or fewer.");
  return { sessionId: input.sessionId, useful: input.useful, reason, somethingElse };
}

export function anonymousEventBucket(ownerHash: string, secret: string, occurredAt = new Date()): string {
  const utcDay = occurredAt.toISOString().slice(0, 10);
  return createHmac("sha256", secret).update(`product-events:v1:${utcDay}:${ownerHash}`, "utf8").digest("hex").slice(0, 32);
}

function emptyCounts(): Record<ProductEventName, number> {
  return Object.fromEntries(PRODUCT_EVENT_NAMES.map((name) => [name, 0])) as Record<ProductEventName, number>;
}

function ratio(value: number, denominator: number): number | null { return denominator ? Number((value / denominator).toFixed(4)) : null; }

function reportFromParts(input: { start: string; end: string; eventCounts: Array<{ event_name: ProductEventName; count: number }>; semanticTaskCount: number; estimatedUnitsReserved: number; budget: ProviderBudgetStatus; failures: Array<{ code: string; count: number }>; repairBlocks: Array<{ reason: string; count: number }> }): BetaReport {
  const counts = emptyCounts();
  for (const row of input.eventCounts) counts[row.event_name] = Number(row.count);
  const funnelNames: ProductEventName[] = ["try_started", "photo_added", "product_added", "generation_started", "provider_succeeded", "result_viewed", "passport_viewed"];
  const funnel = funnelNames.map((event, index) => ({ event, count: counts[event], ratioFromPrevious: index === 0 ? null : ratio(counts[event], counts[funnelNames[index - 1]!]!) }));
  return {
    period: { start: input.start, end: input.end }, counts, funnel,
    protect: { protectedAtLeastOne: counts.protected_region_added, skipped: counts.protect_skipped },
    preserve: { offered: counts.preserve_offered, started: counts.preserve_started, restored: counts.preserve_restored, startRate: ratio(counts.preserve_started, counts.preserve_offered), restoreRate: ratio(counts.preserve_restored, counts.preserve_started) },
    provider: { semanticTaskCount: input.semanticTaskCount, estimatedUnitsReserved: input.estimatedUnitsReserved, budget: input.budget },
    failureCodeCounts: Object.fromEntries(input.failures.map((row) => [row.code, Number(row.count)])),
    repairBlockReasonCounts: Object.fromEntries(input.repairBlocks.map((row) => [row.reason, Number(row.count)])),
  };
}

export class PostgresProductAnalyticsStore implements ProductAnalyticsStore {
  constructor(private readonly database: DatabaseClient) {}

  async record(input: ProductEventInput, retentionDays: number): Promise<boolean> {
    const event = validateProductEvent(input);
    const rows = await this.database.query<{ id: string }>(`
      INSERT INTO product_events (id, occurred_at, event_name, anonymous_session_bucket, try_on_session_id, category, properties, deduplication_key, expires_at)
      VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::jsonb, $8, $2::timestamptz + ($9 * interval '1 day'))
      ON CONFLICT (deduplication_key) DO NOTHING RETURNING id
    `, [randomUUID(), event.occurredAt, event.eventName, event.anonymousSessionBucket, event.tryOnSessionId, event.category, JSON.stringify(event.properties), event.deduplicationKey, retentionDays]);
    return Boolean(rows[0]);
  }

  async submitFeedback(input: FeedbackInput, retentionDays: number): Promise<void> {
    const feedback = validateFeedback(input);
    const rows = await this.database.query<{ id: string }>(`
      INSERT INTO beta_feedback (id, try_on_session_id, useful, reason, something_else, submitted_at, expires_at)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, now(), now() + ($6 * interval '1 day'))
      ON CONFLICT (try_on_session_id) DO NOTHING RETURNING id
    `, [randomUUID(), feedback.sessionId, feedback.useful, feedback.reason, feedback.somethingElse, retentionDays]);
    if (!rows[0]) throw new Error("Feedback has already been submitted for this result.");
  }

  async deleteFeedback(sessionId: string): Promise<void> { await this.database.query("DELETE FROM beta_feedback WHERE try_on_session_id = $1::uuid", [sessionId]); }

  async cleanupExpired(): Promise<AnalyticsCleanupSummary> {
    const eventRows = await this.database.query<{ count: number }>("WITH deleted AS (DELETE FROM product_events WHERE expires_at <= now() RETURNING 1) SELECT count(*)::integer AS count FROM deleted");
    const feedbackRows = await this.database.query<{ count: number }>("WITH deleted AS (DELETE FROM beta_feedback WHERE expires_at <= now() RETURNING 1) SELECT count(*)::integer AS count FROM deleted");
    return { eventsDeleted: eventRows[0]?.count ?? 0, feedbackDeleted: feedbackRows[0]?.count ?? 0 };
  }

  async recordCleanupRun(input: CleanupRunInput): Promise<void> {
    await this.database.query(`
      INSERT INTO beta_cleanup_runs (id, started_at, completed_at, status, sessions_examined, sessions_cleaned, sessions_failed, events_deleted, feedback_deleted, error_code)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [randomUUID(), input.startedAt, input.completedAt, input.status, input.sessions.examined, input.sessions.cleaned, input.sessions.failed, input.eventsDeleted, input.feedbackDeleted, input.errorCode ?? null]);
  }

  async betaReport(input: { start: string; end: string; budget: number }): Promise<BetaReport> {
    const [eventCounts, provider, budgetRows, failures, repairBlocks] = await Promise.all([
      this.database.query<{ event_name: ProductEventName; count: number }>("SELECT event_name, count(*)::integer AS count FROM product_events WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY event_name ORDER BY event_name", [input.start, input.end]),
      this.database.query<{ task_count: number; units: number }>("SELECT count(*) FILTER (WHERE state IN ('SUBMITTED','UNCERTAIN'))::integer AS task_count, COALESCE(sum(expected_units) FILTER (WHERE state <> 'RELEASED'),0)::integer AS units FROM provider_unit_reservations WHERE created_at >= $1 AND created_at < $2", [input.start, input.end]),
      this.database.query<{ reserved_units: number }>("SELECT reserved_units FROM provider_budget_days WHERE utc_day = (now() AT TIME ZONE 'UTC')::date"),
      this.database.query<{ code: string; count: number }>("SELECT properties->>'error_code' AS code, count(*)::integer AS count FROM product_events WHERE occurred_at >= $1 AND occurred_at < $2 AND properties ? 'error_code' GROUP BY code ORDER BY count DESC, code", [input.start, input.end]),
      this.database.query<{ reason: string; count: number }>("SELECT properties->>'repair_eligibility_reason' AS reason, count(*)::integer AS count FROM product_events WHERE occurred_at >= $1 AND occurred_at < $2 AND event_name = 'preserve_blocked' GROUP BY reason ORDER BY count DESC, reason", [input.start, input.end]),
    ]);
    const reservedUnits = budgetRows[0]?.reserved_units ?? 0;
    return reportFromParts({ start: input.start, end: input.end, eventCounts, semanticTaskCount: provider[0]?.task_count ?? 0, estimatedUnitsReserved: provider[0]?.units ?? 0, budget: { utcDay: new Date().toISOString().slice(0, 10), configuredBudget: input.budget, reservedUnits, remainingUnits: Math.max(0, input.budget - reservedUnits) }, failures, repairBlocks });
  }

  async betaStatus(input: { generationEnabled: boolean; budget: number; utcDay?: string }): Promise<BetaStatus> {
    const utcDay = input.utcDay ?? new Date().toISOString().slice(0, 10);
    const [budgetRows, sessionRows, eventRows, cleanupRows] = await Promise.all([
      this.database.query<{ reserved_units: number }>("SELECT reserved_units FROM provider_budget_days WHERE utc_day = $1::date", [utcDay]),
      this.database.query<{ count: number }>("SELECT count(*)::integer AS count FROM try_on_sessions WHERE created_at >= $1::date AND created_at < $1::date + interval '1 day' AND COALESCE(session_payload->>'qaFixture','') <> 'UI_ONLY_NO_PROVIDER_EVENT'", [utcDay]),
      this.database.query<{ event_name: ProductEventName; count: number }>("SELECT event_name, count(*)::integer AS count FROM product_events WHERE occurred_at >= $1::date AND occurred_at < $1::date + interval '1 day' AND event_name IN ('provider_succeeded','provider_failed') GROUP BY event_name", [utcDay]),
      this.database.query<{ completed_at: string; status: "SUCCESS" | "FAILED"; sessions_cleaned: number; events_deleted: number; feedback_deleted: number; error_code: string | null }>("SELECT completed_at, status, sessions_cleaned, events_deleted, feedback_deleted, error_code FROM beta_cleanup_runs ORDER BY completed_at DESC LIMIT 1"),
    ]);
    const reservedUnits = budgetRows[0]?.reserved_units ?? 0;
    const eventCount = (name: ProductEventName) => eventRows.find((row) => row.event_name === name)?.count ?? 0;
    const latest = cleanupRows[0];
    return {
      generationEnabled: input.generationEnabled,
      budget: { utcDay, configuredBudget: input.budget, reservedUnits, remainingUnits: Math.max(0, input.budget - reservedUnits) },
      sessionsCreatedToday: sessionRows[0]?.count ?? 0,
      providerSucceededToday: eventCount("provider_succeeded"), providerFailedToday: eventCount("provider_failed"),
      latestCleanup: latest ? { completedAt: latest.completed_at, status: latest.status, sessionsCleaned: latest.sessions_cleaned, eventsDeleted: latest.events_deleted, feedbackDeleted: latest.feedback_deleted, errorCode: latest.error_code } : null,
    };
  }
}

export class MemoryProductAnalyticsStore implements ProductAnalyticsStore {
  readonly events: StoredProductEvent[] = [];
  readonly feedback = new Map<string, ReturnType<typeof validateFeedback> & { expiresAt: string }>();
  readonly cleanupRuns: CleanupRunInput[] = [];
  private readonly providerStatus: ProviderBudgetStatus = { utcDay: new Date().toISOString().slice(0, 10), configuredBudget: 10, reservedUnits: 0, remainingUnits: 10 };

  async record(input: ProductEventInput, retentionDays: number): Promise<boolean> {
    const value = validateProductEvent(input);
    if (value.deduplicationKey && this.events.some((event) => event.deduplicationKey === value.deduplicationKey)) return false;
    this.events.push({ ...value, id: randomUUID(), expiresAt: new Date(Date.parse(value.occurredAt) + retentionDays * 86_400_000).toISOString() });
    return true;
  }
  async submitFeedback(input: FeedbackInput, retentionDays: number): Promise<void> { const value = validateFeedback(input); if (this.feedback.has(value.sessionId)) throw new Error("Feedback has already been submitted for this result."); this.feedback.set(value.sessionId, { ...value, expiresAt: new Date(Date.now() + retentionDays * 86_400_000).toISOString() }); }
  async deleteFeedback(sessionId: string): Promise<void> { this.feedback.delete(sessionId); }
  async cleanupExpired(): Promise<AnalyticsCleanupSummary> { const now = Date.now(); const before = this.events.length; for (let index = this.events.length - 1; index >= 0; index -= 1) if (Date.parse(this.events[index]!.expiresAt) <= now) this.events.splice(index, 1); let feedbackDeleted = 0; for (const [id, value] of this.feedback) if (Date.parse(value.expiresAt) <= now) { this.feedback.delete(id); feedbackDeleted += 1; } return { eventsDeleted: before - this.events.length, feedbackDeleted }; }
  async recordCleanupRun(input: CleanupRunInput): Promise<void> { this.cleanupRuns.push(input); }
  async betaReport(input: { start: string; end: string; budget: number }): Promise<BetaReport> { const selected = this.events.filter((event) => event.occurredAt >= input.start && event.occurredAt < input.end); const grouped = PRODUCT_EVENT_NAMES.map((event_name) => ({ event_name, count: selected.filter((event) => event.eventName === event_name).length })); const failures = [...new Set(selected.map((event) => event.properties.error_code).filter((value): value is string => typeof value === "string"))].map((code) => ({ code, count: selected.filter((event) => event.properties.error_code === code).length })); const reasons = [...new Set(selected.filter((event) => event.eventName === "preserve_blocked").map((event) => event.properties.repair_eligibility_reason).filter((value): value is string => typeof value === "string"))].map((reason) => ({ reason, count: selected.filter((event) => event.properties.repair_eligibility_reason === reason).length })); return reportFromParts({ start: input.start, end: input.end, eventCounts: grouped, semanticTaskCount: selected.filter((event) => event.eventName === "generation_started").length, estimatedUnitsReserved: 0, budget: { ...this.providerStatus, configuredBudget: input.budget, remainingUnits: Math.max(0, input.budget - this.providerStatus.reservedUnits) }, failures, repairBlocks: reasons }); }
  async betaStatus(input: { generationEnabled: boolean; budget: number; utcDay?: string }): Promise<BetaStatus> { const utcDay = input.utcDay ?? this.providerStatus.utcDay; return { generationEnabled: input.generationEnabled, budget: { utcDay, configuredBudget: input.budget, reservedUnits: this.providerStatus.reservedUnits, remainingUnits: Math.max(0, input.budget - this.providerStatus.reservedUnits) }, sessionsCreatedToday: this.events.filter((event) => event.eventName === "try_started" && event.occurredAt.startsWith(utcDay)).length, providerSucceededToday: this.events.filter((event) => event.eventName === "provider_succeeded" && event.occurredAt.startsWith(utcDay)).length, providerFailedToday: this.events.filter((event) => event.eventName === "provider_failed" && event.occurredAt.startsWith(utcDay)).length, latestCleanup: null }; }
}

export function durationBucket(milliseconds: number): "LT_10S" | "10_30S" | "30_60S" | "1_3M" | "GT_3M" {
  if (milliseconds < 10_000) return "LT_10S";
  if (milliseconds < 30_000) return "10_30S";
  if (milliseconds < 60_000) return "30_60S";
  if (milliseconds < 180_000) return "1_3M";
  return "GT_3M";
}

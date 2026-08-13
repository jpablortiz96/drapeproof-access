import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NeonDatabaseClient } from "../src/product/production/db.js";
import { VercelPrivateObjectStore } from "../src/product/production/blob.js";
import { PostgresBlobSessionRepository } from "../src/product/production/repository.js";
import type { PublicTryOnSession, TryOnSession, UserProtectedRegion } from "../src/product/live/types.js";
import { invokeSingleLiveGenerate, liveGenerateRequest, runNoCostProductionChecks, type SmokeCheckResult } from "./live-production-smoke-http.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const cleanupSessionId = args.find((argument) => argument.startsWith("--cleanup-session="))?.slice("--cleanup-session=".length);
const rawBase = args.find((argument) => !argument.startsWith("--")) ?? "https://drapeproof-access.vercel.app";
const base = new URL(rawBase).origin;
if (new URL(base).protocol !== "https:") throw new Error("Live production smoke requires HTTPS.");
const databaseUrl = process.env.DATABASE_URL?.trim();
const blobToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();
if (!databaseUrl || !blobToken) throw new Error("DATABASE_URL and BLOB_READ_WRITE_TOKEN are required for credentialed verification.");

const sourcePath = resolve("web/public/product/sample-original.png");
const productPath = resolve("web/public/product/sample-garment.png");
const regionPath = resolve("tests/fixtures/regions/wheelchair-protected.json");
const sourceBytes = await readFile(sourcePath);
const productBytes = await readFile(productPath);
const regionDefinition = JSON.parse(await readFile(regionPath, "utf8")) as { regions: UserProtectedRegion[] };
if (!Array.isArray(regionDefinition.regions) || regionDefinition.regions.length !== 3) throw new Error("Expected the three reviewed protected regions.");

const database = new NeonDatabaseClient(databaseUrl);
const objects = new VercelPrivateObjectStore(blobToken);

if (cleanupSessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(cleanupSessionId)) throw new Error("Cleanup requires a valid session identifier.");
  const rows = await database.query<{
    anonymous_owner_hash: string;
    expires_at: string;
    deleted_at: string | null;
    provider_status: string;
    provider_task_id: string | null;
    source_blob_key: string | null;
    product_blob_key: string | null;
    provider_result_blob_key: string | null;
    passport_blob_key: string | null;
    session_payload: TryOnSession;
  }>(`SELECT anonymous_owner_hash, expires_at, deleted_at, provider_status, provider_task_id,
      source_blob_key, product_blob_key, provider_result_blob_key, passport_blob_key, session_payload
    FROM try_on_sessions WHERE id = $1`, [cleanupSessionId]);
  const row = rows[0];
  let cleanupFailed = false;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ present: false, cleanup_required: false })}\n`);
  } else {
    const keys = [row.source_blob_key, row.product_blob_key, row.provider_result_blob_key, row.passport_blob_key, ...row.session_payload.derivedBlobKeys]
      .filter((key): key is string => Boolean(key));
    process.stdout.write(`${JSON.stringify({ before: {
      present: true,
      expired: Date.parse(row.expires_at) <= Date.now(),
      deleted: Boolean(row.deleted_at),
      provider_status: row.provider_status,
      provider_task_persisted: Boolean(row.provider_task_id),
      source_blob_present: Boolean(row.source_blob_key),
      product_blob_present: Boolean(row.product_blob_key),
      result_blob_present: Boolean(row.provider_result_blob_key),
      passport_blob_present: Boolean(row.passport_blob_key),
      controlled_blob_count: keys.length,
    } })}\n`);
    const repository = new PostgresBlobSessionRepository(database, objects, 24);
    const deleted = await repository.delete(cleanupSessionId, row.anonymous_owner_hash);
    const after = (await database.query<{
      deleted_at: string | null;
      source_blob_key: string | null;
      product_blob_key: string | null;
      provider_result_blob_key: string | null;
      passport_blob_key: string | null;
    }>(`SELECT deleted_at, source_blob_key, product_blob_key, provider_result_blob_key, passport_blob_key
      FROM try_on_sessions WHERE id = $1`, [cleanupSessionId]))[0];
    let survivingBlobCount = 0;
    for (const key of keys) {
      try { await objects.read(key); survivingBlobCount += 1; } catch { /* absence is the expected state */ }
    }
    process.stdout.write(`${JSON.stringify({ cleanup: {
      repository_delete_returned: deleted,
      tombstoned: Boolean(after?.deleted_at),
      primary_blob_references_cleared: Boolean(after) && !after?.source_blob_key && !after?.product_blob_key && !after?.provider_result_blob_key && !after?.passport_blob_key,
      controlled_blobs_removed: survivingBlobCount === 0,
      surviving_blob_count: survivingBlobCount,
      provider_calls: 0,
      youcam_units: 0,
    } })}\n`);
    cleanupFailed = !deleted || !after?.deleted_at || Boolean(after.source_blob_key || after.product_blob_key || after.provider_result_blob_key || after.passport_blob_key) || survivingBlobCount !== 0;
  }
  process.exit(cleanupFailed ? 1 : 0);
}
const startedAt = new Date().toISOString();
const evidenceRoot = resolve(".tmp/live-provider-smoke", startedAt.replaceAll(":", "").replaceAll(".", "-"));
let sessionId: string | undefined;
let cookie: string | undefined;
let generationRouteInvocations = 0;
let providerStatusPolls = 0;
let lastSession: PublicTryOnSession | undefined;
let rowSnapshot: ProductionRow | undefined;
let outcome: "PASS" | "FAIL" = "FAIL";
let resultDownloads = 0;
let passportVerified = false;
let storedArtifactCountBeforeDeletion = 0;
let deletionVerified = false;
let generateDispatchedAtMs: number | undefined;
let providerLatencyMs: number | undefined;
let ownerResultPageVerified = false;
let unauthorizedSessionDenied = false;
let unauthorizedMediaDenied = false;
let productionChecks: SmokeCheckResult[] = [];
const lifecycle: Array<{ timestamp_utc: string; event: string; stage?: string | undefined; provider_state?: string | undefined; provider_phase?: string | undefined; final_state?: string | undefined }> = [];

interface ProductionRow {
  id: string;
  category: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  deleted_at: string | null;
  source_blob_key: string | null;
  product_blob_key: string | null;
  provider_result_blob_key: string | null;
  passport_blob_key: string | null;
  provider_name: string;
  provider_category: string | null;
  provider_status: string;
  provider_error_code: string | null;
  provider_task_id: string | null;
  provider_idempotency_key: string | null;
  continuity_status: string | null;
  face_analysis_enabled: boolean;
  final_state: string;
  stage: string;
  session_payload: TryOnSession;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function failureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/upload/i.test(message)) return "UPLOAD_FAILURE";
  if (/timeout|deadline/i.test(message)) return "PROVIDER_TIMEOUT";
  if (/provider.*reject|task start failed/i.test(message)) return "PROVIDER_REJECTED";
  if (/provider.*fail/i.test(message)) return "PROVIDER_FAILED";
  if (/continuity/i.test(message)) return "CONTINUITY_BLOCKED";
  if (/protected.region|verification/i.test(message)) return "VERIFICATION_FAILURE";
  if (/passport/i.test(message)) return "PASSPORT_FAILURE";
  if (/neon|blob|persist/i.test(message)) return "PERSISTENCE_FAILURE";
  if (/production health|session|generate|http/i.test(message)) return "APPLICATION_FAILURE";
  return "RUNNER_FAILURE";
}

async function responseError(response: Response, step: string): Promise<never> {
  const body = (await response.text()).slice(0, 500);
  throw new Error(`${step} returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

async function owned(path: string, init: RequestInit = {}): Promise<Response> {
  if (!cookie) throw new Error("Owner cookie is unavailable.");
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  if (init.method && init.method !== "GET") headers.set("Origin", base);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function readPublicSession(): Promise<PublicTryOnSession> {
  if (!sessionId) throw new Error("Session identifier is unavailable.");
  const response = await owned(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) return responseError(response, "Session read");
  const payload = await response.json() as { session?: PublicTryOnSession };
  if (!payload.session) throw new Error("Session response was missing its public record.");
  lastSession = payload.session;
  return payload.session;
}

async function readRow(): Promise<ProductionRow> {
  if (!sessionId) throw new Error("Session identifier is unavailable.");
  const rows = await database.query<ProductionRow>(`
    SELECT id, category, status, created_at, updated_at, expires_at, deleted_at,
      source_blob_key, product_blob_key, provider_result_blob_key, passport_blob_key,
      provider_name, provider_category, provider_status, provider_error_code,
      provider_task_id, provider_idempotency_key, continuity_status,
      face_analysis_enabled, final_state, stage, session_payload
    FROM try_on_sessions WHERE id = $1
  `, [sessionId]);
  if (!rows[0]) throw new Error("The production Neon row was not found.");
  rowSnapshot = rows[0];
  return rows[0];
}

async function upload(kind: "source" | "product", bytes: Buffer, name: string): Promise<void> {
  if (!sessionId) throw new Error("Session identifier is unavailable.");
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
  const response = await owned(`/api/sessions/${encodeURIComponent(sessionId)}?upload=${kind}`, { method: "POST", body: form });
  if (!response.ok) await responseError(response, `${kind} upload`);
}

async function deleteThroughProductPath(storedKeys: string[]): Promise<void> {
  if (!sessionId) throw new Error("Session identifier is unavailable.");
  const remove = await owned(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (remove.status !== 204) await responseError(remove, "Session deletion");
  const unavailable = await owned(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (unavailable.status !== 404) throw new Error(`Deleted session returned ${unavailable.status}, expected 404.`);
  const deleted = await readRow();
  if (!deleted.deleted_at || deleted.source_blob_key || deleted.product_blob_key || deleted.provider_result_blob_key || deleted.passport_blob_key) {
    throw new Error("Deleted Neon tombstone did not clear every primary Blob reference.");
  }
  for (const key of storedKeys) {
    let removed = false;
    try { await objects.read(key); } catch { removed = true; }
    if (!removed) throw new Error("A DrapeProof-controlled Blob survived successful session deletion.");
  }
  deletionVerified = true;
}

async function runExistingLiveTrigger(): Promise<void> {
  if (!sessionId || !cookie) throw new Error("Prepared session context is unavailable.");
  productionChecks = await runNoCostProductionChecks(base);
  for (const check of productionChecks) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name} (${check.status})\n`);
  if (productionChecks.some((check) => !check.ok)) throw new Error("No-cost production checks failed before the provider boundary.");
  if (generationRouteInvocations !== 0) throw new Error("Duplicate provider start blocked by the runner one-shot guard.");
  generationRouteInvocations = 1;
  generateDispatchedAtMs = Date.now();
  lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "GENERATE_DISPATCHED" });
  const response = await invokeSingleLiveGenerate(base, sessionId, cookie);
  process.stdout.write(`${response.ok ? "PASS" : "FAIL"} explicit live provider start (${response.status})\n`);
  if (!response.ok) await responseError(response, "Explicit live provider start");
}

async function persistEvidence(error?: unknown): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true });
  const row = rowSnapshot;
  const record = {
    schema_version: "1.0",
    status: outcome === "PASS" ? "PASS_LIVE_PRODUCTION_SMOKE" : "FAIL_LIVE_PRODUCTION_SMOKE",
    started_at_utc: startedAt,
    recorded_at_utc: new Date().toISOString(),
    production_url: base,
    session_id: sessionId ?? null,
    inputs: {
      classification: "SYNTHETIC_TEST_INPUT",
      source_sha256: sha256(sourceBytes),
      product_sha256: sha256(productBytes),
      source_fixture: "reviewed seated/wheelchair Clothes fixture",
      product_fixture: "reviewed upper-body garment fixture",
    },
    controls: {
      category: "CLOTHING",
      provider_product: "AI Clothes Virtual Try-On",
      provider_version: "Clothes V4.0",
      face_appearance_enabled: false,
      bag_calls: 0,
      skin_analysis_calls: 0,
      generation_route_invocations: generationRouteInvocations,
      semantic_failure_retries: 0,
    },
    provider_calls: {
      unit_consuming: [{
        method: "POST",
        path: "/s2s/v2.0/task/cloth-v4",
        confirmed_semantic_tasks: row?.provider_task_id ? 1 : 0,
        generation_route_invocations: generationRouteInvocations,
      }],
      non_unit_workflow: {
        file_initializations: generationRouteInvocations ? 2 : 0,
        presigned_file_uploads: generationRouteInvocations ? 2 : 0,
        task_status_polls: providerStatusPolls,
        result_downloads: resultDownloads,
      },
      provider_task_id_sha256: row?.provider_task_id ? sha256(row.provider_task_id) : null,
      provider_latency_ms: providerLatencyMs ?? null,
    },
    unit_accounting: {
      expected_units: row?.provider_task_id ? 2 : 0,
      observed_units: null,
      observation: "Direct provider balance delta is not exposed by the production workflow.",
      expected_source: "Recorded authenticated feature-cost response: AI Clothes Virtual Try-On V4.0, amount 2 per result_image, proc_unit 1.",
    },
    lifecycle,
    production_checks: productionChecks,
    persistence: row ? {
      neon_row_present: true,
      category: row.category,
      provider_name: row.provider_name,
      provider_category: row.provider_category,
      provider_status: row.provider_status,
      provider_error_code: row.provider_error_code,
      provider_task_persisted: Boolean(row.provider_task_id),
      idempotency_key_persisted: Boolean(row.provider_idempotency_key),
      source_blob_present: Boolean(row.source_blob_key),
      product_blob_present: Boolean(row.product_blob_key),
      result_blob_present: Boolean(row.provider_result_blob_key),
      passport_blob_present: Boolean(row.passport_blob_key),
      stage: row.stage,
      final_state: row.final_state,
      continuity_status: row.continuity_status,
      protected_region_count: row.session_payload.protectedRegionResults.length,
      face_analysis_enabled: row.face_analysis_enabled,
      expires_at: row.expires_at,
      deleted_at: row.deleted_at,
    } : null,
    public_result: lastSession ? {
      provider_state: lastSession.provider.state,
      provider_phase: lastSession.provider.phase ?? null,
      provider_product: lastSession.provider.product,
      provider_version: lastSession.provider.version,
      stage: lastSession.stage,
      final_state: lastSession.finalState,
      continuity: lastSession.continuity,
      protected_region_results: lastSession.protectedRegionResults,
      face_appearance: lastSession.faceAppearance,
      result_asset_present: Boolean(lastSession.providerResult),
      result_metadata: lastSession.providerResult,
    } : null,
    passport_verified: passportVerified,
    security: {
      owner_result_page_verified: ownerResultPageVerified,
      unauthorized_session_denied: unauthorizedSessionDenied,
      unauthorized_result_media_denied: unauthorizedMediaDenied,
    },
    stored_artifact_count_before_deletion: storedArtifactCountBeforeDeletion,
    deletion: {
      verified: deletionVerified,
      owner_access_invalidated: deletionVerified,
      neon_tombstone_retained_for_cron: deletionVerified,
      controlled_blobs_removed: deletionVerified,
    },
    retention: row ? {
      expires_at: row.expires_at,
      retained_for_24_hour_policy: !row.deleted_at,
    } : null,
    error: error instanceof Error ? { category: failureCategory(error), name: error.name, message: error.message } : error ? { category: failureCategory(error), message: String(error) } : null,
  };
  await writeFile(resolve(evidenceRoot, "report.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(`Evidence: ${resolve(evidenceRoot, "report.json")}\n`);
}

try {
  const health = await fetch(`${base}/api/health`);
  if (!health.ok || (await health.json() as { status?: string }).status !== "ok") throw new Error("Production health preflight did not pass.");

  const create = await fetch(`${base}/api/health`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ action: "create_session" }) });
  if (create.status !== 201) await responseError(create, "Session creation");
  const created = await create.json() as { session?: PublicTryOnSession };
  sessionId = created.session?.id;
  if (!sessionId) throw new Error("Session creation did not return an identifier.");
  const ownerToken = /(?:^|[,;]\s*)dp_anon=([^;]+)/.exec(create.headers.get("set-cookie") ?? "")?.[1];
  if (!ownerToken) throw new Error("Session creation did not return the owner cookie.");
  cookie = `dp_anon=${ownerToken}`;
  lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "SESSION_CREATED", stage: created.session?.stage });
  process.stdout.write(`Prepared production session ${sessionId}.\n`);

  await upload("source", sourceBytes, "live-clothes-source.png");
  lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "SOURCE_UPLOADED" });
  await upload("product", productBytes, "live-clothes-product.png");
  lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "PRODUCT_UPLOADED" });
  const configure = await owned(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "CLOTHING", protectedRegions: regionDefinition.regions, faceAppearanceEnabled: false }),
  });
  if (!configure.ok) await responseError(configure, "Session configuration");
  lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "SESSION_REVIEW_CONFIGURED", stage: "REVIEW" });

  const ready = await readPublicSession();
  if (ready.stage !== "REVIEW" || ready.category !== "CLOTHING" || ready.protectedRegions.length !== 3 || ready.faceAppearance.enabled || ready.provider.product !== "AI Clothes Virtual Try-On" || ready.provider.version !== "Clothes V4.0") {
    throw new Error("Prepared session did not satisfy the Clothes-only reviewed-session gate.");
  }
  const ttlHours = (Date.parse(ready.expiresAt) - Date.parse(ready.createdAt)) / 3_600_000;
  if (Math.abs(ttlHours - 24) > 0.01) throw new Error(`Production retention TTL was ${ttlHours} hours, expected 24.`);
  const preparedRow = await readRow();
  if (!preparedRow.source_blob_key || !preparedRow.product_blob_key || preparedRow.provider_task_id || preparedRow.provider_status !== "NOT_STARTED") {
    throw new Error("Neon/Blob pre-generation state was not clean and ready.");
  }
  if (!(await objects.read(preparedRow.source_blob_key)).byteLength || !(await objects.read(preparedRow.product_blob_key)).byteLength) {
    throw new Error("Prepared private Blob inputs could not be read credentialedly.");
  }
  process.stdout.write("PASS preflight: uploads, private Blob, Neon, CLOTHING, Clothes V4.0, face analysis off, three reviewed regions, 24-hour TTL.\n");

  if (dryRun) {
    const checks = await runNoCostProductionChecks(base);
    for (const check of checks) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name} (${check.status})\n`);
    if (checks.some((check) => !check.ok)) throw new Error("No-cost production checks failed during dry run.");
    const generateRequest = liveGenerateRequest(base, sessionId, cookie);
    if (generateRequest.url !== `${base}/api/sessions/${encodeURIComponent(sessionId)}?action=generate` || generateRequest.init.method !== "POST") {
      throw new Error("The direct generate request could not be constructed deterministically.");
    }
    await deleteThroughProductPath([preparedRow.source_blob_key, preparedRow.product_blob_key]);
    process.stdout.write("PASS dry-run cleanup: owner access invalidated, Neon tombstone retained for cron, and private input Blobs removed.\n");
    process.stdout.write("PROVIDER_CALLS=0\nYOUCAM_UNITS=0\nDRY_RUN_READY_FOR_GENERATE\n");
  } else {
  await runExistingLiveTrigger();
  let current = await readPublicSession();
  let persisted = await readRow();
  lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "PROVIDER_TASK_PERSISTED", stage: current.stage, provider_state: current.provider.state, provider_phase: current.provider.phase, final_state: current.finalState });
  if (generationRouteInvocations !== 1) throw new Error("Generation route invocation count was not exactly one.");
  if (current.category !== "CLOTHING" || current.provider.product !== "AI Clothes Virtual Try-On" || current.provider.version !== "Clothes V4.0" || current.faceAppearance.enabled) {
    throw new Error("The started provider state diverged from the Clothes-only gate.");
  }
  if (current.provider.state === "FAILED" || !persisted.provider_task_id) {
    throw new Error(`YouCam Clothes task start failed: ${current.provider.errorCode ?? "PROVIDER_TASK_NOT_PERSISTED"}.`);
  }
  if (!persisted.provider_idempotency_key || persisted.provider_status !== "PROVIDER_SUBMITTED") {
    throw new Error("The provider task was not durably persisted in resumable state.");
  }
  process.stdout.write(`PASS single start: one Clothes V4 task persisted; task fingerprint ${sha256(persisted.provider_task_id).slice(0, 16)}.\n`);

  const deadline = Date.now() + 5 * 60_000;
  while (current.finalState === "PROCESSING") {
    if (Date.now() >= deadline) throw new Error("Live smoke exceeded the five-minute provider deadline.");
    if (current.stage === "CREATING") providerStatusPolls += 1;
    const advance = await owned(`/api/sessions/${encodeURIComponent(sessionId)}?action=process`, { method: "POST" });
    if (!advance.ok) await responseError(advance, "Persisted-task advancement");
    const payload = await advance.json() as { session?: PublicTryOnSession };
    if (!payload.session) throw new Error("Advancement response was missing the session.");
    current = payload.session;
    lastSession = current;
    if (providerLatencyMs === undefined && generateDispatchedAtMs !== undefined && current.provider.state === "SUCCESS") {
      providerLatencyMs = Date.now() - generateDispatchedAtMs;
    }
    lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "SESSION_ADVANCED", stage: current.stage, provider_state: current.provider.state, provider_phase: current.provider.phase, final_state: current.finalState });
    process.stdout.write(`Advance ${providerStatusPolls}: stage=${current.stage} provider=${current.provider.state} final=${current.finalState}.\n`);
    if (current.provider.state === "FAILED" || current.stage === "FAILED") {
      await readRow();
      throw new Error(`Provider workflow failed without retry: ${current.provider.errorCode ?? "PROVIDER_FAILED"}.`);
    }
    if (current.finalState === "PROCESSING") await new Promise((resolveDelay) => setTimeout(resolveDelay, current.stage === "CREATING" ? 3_000 : 250));
  }
  providerLatencyMs ??= generateDispatchedAtMs === undefined ? undefined : Date.now() - generateDispatchedAtMs;

  if (!current.providerResult || current.provider.state !== "SUCCESS" || current.provider.phase !== "PROVIDER_SUCCESS" || current.stage !== "COMPLETE") {
    throw new Error("The production session did not reach a persistent completed provider result.");
  }
  resultDownloads = 1;
  if (current.continuity.localVerificationEligible && current.protectedRegions.length > 0 && current.protectedRegionResults.length !== current.protectedRegions.length) {
    throw new Error("Eligible protected-region verification did not produce one result per reviewed region.");
  }
  if (!current.continuity.localVerificationEligible && current.protectedRegionResults.length !== 0) {
    throw new Error("Protected-region results were produced despite an ineligible Continuity Gate.");
  }

  const result = await owned(`/api/sessions/${encodeURIComponent(sessionId)}/asset/result`);
  if (!result.ok || !(result.headers.get("content-type") ?? "").startsWith("image/") || (await result.arrayBuffer()).byteLength === 0) {
    throw new Error("Owner-authorized persistent result retrieval failed.");
  }
  const passport = await owned(`/api/sessions/${encodeURIComponent(sessionId)}/asset/passport`);
  if (!passport.ok || passport.headers.get("content-type") !== "image/png" || (await passport.arrayBuffer()).byteLength === 0) {
    throw new Error("Passport generation/retrieval failed.");
  }
  passportVerified = true;
  lifecycle.push({ timestamp_utc: new Date().toISOString(), event: "PASSPORT_PERSISTED", stage: current.stage, provider_state: current.provider.state, provider_phase: current.provider.phase, final_state: current.finalState });
  const resultPage = await owned(`/result?id=${encodeURIComponent(sessionId)}`);
  const resultPageBody = await resultPage.text();
  ownerResultPageVerified = resultPage.status === 200 && !/result is no longer available|may have expired or been deleted/i.test(resultPageBody);
  if (!ownerResultPageVerified) throw new Error("Owning-session result page was not accessible.");
  const unauthorizedSession = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`);
  unauthorizedSessionDenied = unauthorizedSession.status === 404;
  if (!unauthorizedSessionDenied) throw new Error(`Unauthorized session access returned ${unauthorizedSession.status}, expected 404.`);
  const unauthorizedMedia = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/asset/result`);
  unauthorizedMediaDenied = unauthorizedMedia.status === 404 && /private.*no-store/i.test(unauthorizedMedia.headers.get("cache-control") ?? "");
  if (!unauthorizedMediaDenied) throw new Error("Unauthorized result media was not denied as a private/no-store 404.");
  const persistentRead = await readPublicSession();
  if (persistentRead.finalState !== current.finalState || !persistentRead.providerResult) throw new Error("Completed result did not persist across reads.");
  persisted = await readRow();
  const storedKeys = [persisted.source_blob_key, persisted.product_blob_key, persisted.provider_result_blob_key, persisted.passport_blob_key, ...persisted.session_payload.derivedBlobKeys]
    .filter((key): key is string => Boolean(key));
  storedArtifactCountBeforeDeletion = storedKeys.length;
  if (!persisted.provider_result_blob_key || !persisted.passport_blob_key || storedKeys.length < 4) throw new Error("Neon did not persist result and Passport Blob references.");
  for (const key of storedKeys) if (!(await objects.read(key)).byteLength) throw new Error("A persisted private result artifact was empty.");
  process.stdout.write(`PASS result: final=${current.finalState}, continuity=${current.continuity.state}, eligible=${current.continuity.localVerificationEligible}, regions=${current.protectedRegionResults.length}, Passport=persisted.\n`);

  outcome = "PASS";
  await persistEvidence();
  process.stdout.write(`PASS persistence: session and ${storedKeys.length} private artifacts retained until ${persisted.expires_at}.\n`);
  process.stdout.write("PASS_LIVE_PRODUCTION_SMOKE\n");
  }
} catch (error) {
  try { if (sessionId) await readRow(); } catch { /* preserve the primary failure */ }
  if (dryRun) {
    if (sessionId && cookie && !deletionVerified) {
      const keys = [rowSnapshot?.source_blob_key, rowSnapshot?.product_blob_key, rowSnapshot?.provider_result_blob_key, rowSnapshot?.passport_blob_key, ...(rowSnapshot?.session_payload.derivedBlobKeys ?? [])]
        .filter((key): key is string => Boolean(key));
      try { await deleteThroughProductPath(keys); } catch { /* the primary dry-run failure remains authoritative */ }
    }
    process.stderr.write(`FAIL_DRY_RUN: ${error instanceof Error ? error.message : String(error)}\n`);
  } else {
    try { await persistEvidence(error); } catch (evidenceError) {
      process.stderr.write(`Evidence write also failed: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}\n`);
    }
    process.stderr.write(`FAIL_LIVE_PRODUCTION_SMOKE: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}

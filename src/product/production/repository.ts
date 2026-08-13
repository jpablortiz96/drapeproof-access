import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { CleanupSummary, SessionRepository } from "../live/repository.js";
import { newSession } from "../live/repository.js";
import type { SessionAsset, SessionPreservationAttempt, TryOnSession } from "../live/types.js";
import type { PrivateObjectStore } from "./blob.js";
import type { DatabaseClient } from "./db.js";
import { logServerEvent } from "./logging.js";

interface SessionRow {
  session_payload: TryOnSession;
}

function payload(value: TryOnSession): string { return JSON.stringify(value); }

function assetKeys(session: TryOnSession): string[] {
  const assets = [session.sourceImage, session.productImage, session.providerResult, session.preservedResult, session.passportImage,
    ...session.preservationAttempts.map((attempt) => attempt.resultAsset)]
    .filter((asset): asset is SessionAsset => Boolean(asset?.storageKey))
    .map((asset) => asset.storageKey!);
  return [...new Set([...assets, ...session.derivedBlobKeys])];
}

function clearControlledAssets(session: TryOnSession): void {
  session.sourceImage = null; session.productImage = null; session.providerResult = null; session.preservedResult = null; session.passportImage = null;
  session.preservationAttempts = []; session.preservationVersion = 0; session.derivedBlobKeys = [];
}

function normalizedSession(value: TryOnSession): TryOnSession {
  value.preservedResult ??= null;
  value.preservationVersion ??= 0;
  value.preservationAttempts ??= [];
  value.qaFixture ??= null;
  return value;
}

async function filesRecursively(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) output.push(...await filesRecursively(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export class PostgresBlobSessionRepository implements SessionRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly objects: PrivateObjectStore,
    private readonly ttlHours: number,
  ) {}

  sessionDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid session identifier.");
    return resolve(tmpdir(), "drapeproof-runtime", id);
  }

  assetPath(id: string, asset: SessionAsset): string {
    const fingerprint = createHash("sha256").update(asset.storageKey ?? asset.filename).digest("hex").slice(0, 20);
    return resolve(this.sessionDirectory(id), `${fingerprint}${extname(asset.filename)}`);
  }

  async create(ownerHash: string): Promise<TryOnSession> {
    const session = newSession(ownerHash, this.ttlHours);
    await this.database.query(`
      INSERT INTO try_on_sessions (
        id, anonymous_owner_hash, category, status, created_at, updated_at, expires_at, deleted_at,
        source_blob_key, product_blob_key, provider_result_blob_key, passport_blob_key,
        provider_name, provider_category, provider_status, provider_error_code,
        continuity_status, continuity_payload, protected_regions, protected_region_results,
        face_analysis_enabled, face_analysis_payload, final_state, stage, session_payload
      ) VALUES (
        $1, $2, NULL, $3, $4, $4, $5, NULL,
        NULL, NULL, NULL, NULL,
        $6, NULL, $7, NULL,
        NULL, $8::jsonb, $9::jsonb, NULL,
        false, $10::jsonb, $11, $12, $13::jsonb
      )
    `, [session.id, ownerHash, session.stage, session.createdAt, session.expiresAt, session.provider.product,
      session.provider.phase ?? session.provider.state, JSON.stringify(session.continuity), JSON.stringify(session.protectedRegions),
      JSON.stringify(session.faceAppearance), session.finalState, session.stage, payload(session)]);
    return session;
  }

  private async select(text: string, parameters: unknown[]): Promise<TryOnSession | null> {
    const rows = await this.database.query<SessionRow>(text, parameters);
    return rows[0]?.session_payload ? normalizedSession(rows[0].session_payload) : null;
  }

  get(id: string): Promise<TryOnSession | null> {
    return this.select("SELECT session_payload FROM try_on_sessions WHERE id = $1 AND deleted_at IS NULL AND expires_at > now()", [id]);
  }

  getOwned(id: string, ownerHash: string): Promise<TryOnSession | null> {
    return this.select("SELECT session_payload FROM try_on_sessions WHERE id = $1 AND anonymous_owner_hash = $2 AND deleted_at IS NULL AND expires_at > now()", [id, ownerHash]);
  }

  async save(session: TryOnSession): Promise<void> {
    session.updatedAt = new Date().toISOString();
    const rows = await this.database.query<{ id: string }>(`
      UPDATE try_on_sessions SET
        category = $2, status = $3, updated_at = $4, expires_at = $5,
        source_blob_key = $6, product_blob_key = $7, provider_result_blob_key = $8, passport_blob_key = $9,
        provider_name = $10, provider_category = $11, provider_status = $12, provider_error_code = $13,
        provider_task_id = $14, provider_started_at = $15, provider_idempotency_key = $16,
        continuity_status = $17, continuity_payload = $18::jsonb,
        protected_regions = $19::jsonb, protected_region_results = $20::jsonb,
        face_analysis_enabled = $21, face_analysis_payload = $22::jsonb,
        final_state = $23, stage = $24, session_payload = $25::jsonb
      WHERE id = $1 AND anonymous_owner_hash = $26 AND deleted_at IS NULL
      RETURNING id
    `, [session.id, session.category, session.stage, session.updatedAt, session.expiresAt,
      session.sourceImage?.storageKey ?? null, session.productImage?.storageKey ?? null,
      session.providerResult?.storageKey ?? null, session.passportImage?.storageKey ?? null,
      session.provider.product, session.category, session.provider.phase ?? session.provider.state, session.provider.errorCode ?? null,
      session.provider.taskId ?? null, session.provider.startedAt ?? null, session.provider.idempotencyKey ?? null,
      session.continuity.state, JSON.stringify(session.continuity), JSON.stringify(session.protectedRegions),
      JSON.stringify(session.protectedRegionResults), session.faceAppearance.enabled, JSON.stringify(session.faceAppearance),
      session.finalState, session.stage, payload(session), session.ownerId]);
    if (!rows[0]) throw new Error("Session update was rejected.");
    await this.database.query(`
      UPDATE try_on_sessions SET preserved_result_blob_key = $3, preservation_version = $4
      WHERE id = $1 AND anonymous_owner_hash = $2
    `, [session.id, session.ownerId, session.preservedResult?.storageKey ?? null, session.preservationVersion]);
  }

  async list(ownerHash: string): Promise<TryOnSession[]> {
    const rows = await this.database.query<SessionRow>(`
      SELECT session_payload FROM try_on_sessions
      WHERE anonymous_owner_hash = $1 AND deleted_at IS NULL AND expires_at > now()
      ORDER BY updated_at DESC
    `, [ownerHash]);
    return rows.map((row) => normalizedSession(row.session_payload));
  }

  async delete(id: string, ownerHash: string): Promise<boolean> {
    const session = await this.select("SELECT session_payload FROM try_on_sessions WHERE id = $1 AND anonymous_owner_hash = $2", [id, ownerHash]);
    if (!session) return false;
    const deletedAt = session.deletedAt ?? new Date().toISOString();
    session.deletedAt = deletedAt;
    await this.database.query("UPDATE try_on_sessions SET deleted_at = COALESCE(deleted_at, $3), updated_at = now(), session_payload = $4::jsonb WHERE id = $1 AND anonymous_owner_hash = $2", [id, ownerHash, deletedAt, payload(session)]);
    try {
      await this.objects.delete(assetKeys(session));
      clearControlledAssets(session); session.cleanupFailures = [];
      await this.database.query(`
        UPDATE try_on_sessions SET source_blob_key = NULL, product_blob_key = NULL,
          provider_result_blob_key = NULL, preserved_result_blob_key = NULL, passport_blob_key = NULL,
          preservation_version = 0, preservation_lock_token = NULL, preservation_lock_expires_at = NULL,
          session_payload = $3::jsonb
        WHERE id = $1 AND anonymous_owner_hash = $2
      `, [id, ownerHash, payload(session)]);
      await this.database.query("DELETE FROM preservation_attempts WHERE session_id = $1", [id]);
    } catch (error) {
      session.cleanupFailures = ["STORAGE_DELETE_FAILED"];
      await this.database.query("UPDATE try_on_sessions SET cleanup_error_code = 'STORAGE_DELETE_FAILED', session_payload = $3::jsonb WHERE id = $1 AND anonymous_owner_hash = $2", [id, ownerHash, payload(session)]);
      logServerEvent("session.delete.storage_failure", { session_id: id, error_code: "STORAGE_DELETE_FAILED", error });
    }
    return true;
  }

  async claimGeneration(session: TryOnSession): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(`
      UPDATE try_on_sessions SET provider_status = $2, provider_started_at = $3,
        provider_idempotency_key = $4, status = $5, stage = $5, updated_at = now(), session_payload = $6::jsonb
      WHERE id = $1 AND anonymous_owner_hash = $7 AND provider_status = 'NOT_STARTED'
        AND deleted_at IS NULL AND expires_at > now()
      RETURNING id
    `, [session.id, session.provider.phase ?? session.provider.state, session.provider.startedAt ?? null, session.provider.idempotencyKey ?? null,
      session.stage, payload(session), session.ownerId]);
    return Boolean(rows[0]);
  }

  async claimPreservation(session: TryOnSession, attempt: SessionPreservationAttempt): Promise<"CLAIMED" | "DUPLICATE" | "BUSY"> {
    const existing = await this.database.query<{ id: string }>(`
      SELECT id FROM preservation_attempts
      WHERE session_id = $1 AND region_id = $2 AND idempotency_key = $3
      LIMIT 1
    `, [session.id, attempt.regionId, attempt.idempotencyKey]);
    if (existing[0]) return "DUPLICATE";
    const lockToken = attempt.id;
    const rows = await this.database.query<{ id: string }>(`
      WITH claimed AS (
        UPDATE try_on_sessions SET preservation_lock_token = $4,
          preservation_lock_expires_at = now() + interval '3 minutes', updated_at = now()
        WHERE id = $1 AND anonymous_owner_hash = $5 AND deleted_at IS NULL AND expires_at > now()
          AND preservation_version = $6
          AND (preservation_lock_token IS NULL OR preservation_lock_expires_at <= now())
        RETURNING id
      )
      INSERT INTO preservation_attempts (
        id, session_id, region_id, idempotency_key, input_version, state, eligibility,
        engine_version, eligibility_policy_version, intent_estimator, provider_calls, youcam_units,
        trace, created_at, updated_at
      )
      SELECT $4::uuid, id, $2, $3, $6, 'PROCESSING', $7, $8, $9, $10, 0, 0, NULL, $11, $11
      FROM claimed
      ON CONFLICT (session_id, region_id, idempotency_key) DO NOTHING
      RETURNING id
    `, [session.id, attempt.regionId, attempt.idempotencyKey, lockToken, session.ownerId, attempt.inputVersion,
      attempt.eligibility, attempt.engineVersion, attempt.eligibilityPolicyVersion, attempt.intentEstimator, attempt.createdAt]);
    if (!rows[0]) {
      const duplicate = await this.database.query<{ id: string }>("SELECT id FROM preservation_attempts WHERE session_id = $1 AND region_id = $2 AND idempotency_key = $3 LIMIT 1", [session.id, attempt.regionId, attempt.idempotencyKey]);
      return duplicate[0] ? "DUPLICATE" : "BUSY";
    }
    const current = await this.getOwned(session.id, session.ownerId);
    if (!current) return "BUSY";
    current.preservationAttempts.push(attempt);
    await this.database.query("UPDATE try_on_sessions SET session_payload = $3::jsonb WHERE id = $1 AND anonymous_owner_hash = $2", [session.id, session.ownerId, payload(current)]);
    return "CLAIMED";
  }

  async completePreservation(session: TryOnSession, attempt: SessionPreservationAttempt): Promise<void> {
    const index = session.preservationAttempts.findIndex((item) => item.id === attempt.id);
    if (index >= 0) session.preservationAttempts[index] = attempt;
    else session.preservationAttempts.push(attempt);
    session.updatedAt = new Date().toISOString();
    const rows = await this.database.query<{ id: string }>(`
      WITH finished AS (
        UPDATE preservation_attempts SET
          output_version = $4, state = $5, eligibility = $6,
          source_hash = $7, provider_result_hash = $8, generated_input_hash = $9, output_hash = $10,
          repair_blob_key = $11, trace = $12::jsonb, completed_at = $13, updated_at = $13
        WHERE id = $1 AND session_id = $2
        RETURNING id
      )
      UPDATE try_on_sessions SET
        preserved_result_blob_key = $14, preservation_version = $15,
        passport_blob_key = $16, protected_region_results = $17::jsonb,
        session_payload = $18::jsonb, preservation_lock_token = NULL,
        preservation_lock_expires_at = NULL, updated_at = $19
      WHERE id = $2 AND anonymous_owner_hash = $3
        AND preservation_lock_token = $1::text AND EXISTS (SELECT 1 FROM finished)
      RETURNING id
    `, [attempt.id, session.id, session.ownerId, attempt.outputVersion, attempt.state, attempt.eligibility,
      attempt.sourceHash, attempt.providerResultHash, attempt.generatedInputHash, attempt.outputHash,
      attempt.resultAsset?.storageKey ?? null, JSON.stringify(attempt.trace), attempt.completedAt,
      session.preservedResult?.storageKey ?? null, session.preservationVersion, session.passportImage?.storageKey ?? null,
      JSON.stringify(session.protectedRegionResults), payload(session), session.updatedAt]);
    if (!rows[0]) throw new Error("Preservation completion was rejected.");
  }

  async clearPreservation(id: string, ownerHash: string): Promise<void> {
    await this.database.query(`
      DELETE FROM preservation_attempts
      WHERE session_id = $1 AND EXISTS (
        SELECT 1 FROM try_on_sessions WHERE id = $1 AND anonymous_owner_hash = $2
      )
    `, [id, ownerHash]);
    await this.database.query(`
      UPDATE try_on_sessions SET preserved_result_blob_key = NULL, preservation_version = 0,
        preservation_lock_token = NULL, preservation_lock_expires_at = NULL
      WHERE id = $1 AND anonymous_owner_hash = $2
    `, [id, ownerHash]);
  }

  async writeAsset(_id: string, asset: SessionAsset, bytes: Uint8Array): Promise<SessionAsset> {
    const extension = asset.mediaType === "image/png" ? "png" : "jpg";
    const storageKey = await this.objects.putAsset(asset.kind, extension, bytes);
    return { ...asset, storageKey };
  }

  async readAsset(_id: string, asset: SessionAsset): Promise<Uint8Array> {
    if (!asset.storageKey) throw new Error("Persistent asset is missing its object key.");
    return this.objects.read(asset.storageKey);
  }

  async deleteAssets(_id: string, assets: Array<SessionAsset | null>): Promise<void> {
    const keys = assets.filter((asset): asset is SessionAsset => Boolean(asset?.storageKey)).map((asset) => asset.storageKey!);
    await this.objects.delete(keys);
  }

  async deleteDerived(_id: string, keys: string[]): Promise<void> { await this.objects.delete(keys); }

  async materializeAsset(id: string, asset: SessionAsset): Promise<string> {
    const path = this.assetPath(id, asset);
    await mkdir(this.sessionDirectory(id), { recursive: true });
    await writeFile(path, await this.readAsset(id, asset));
    return path;
  }

  async persistDerived(_id: string, directory: string): Promise<string[]> {
    const keys: string[] = [];
    for (const path of await filesRecursively(directory)) {
      const extension = extname(path).slice(1);
      keys.push(await this.objects.putDerived(extension, await readFile(path)));
    }
    return keys;
  }

  async cleanupExpired(): Promise<CleanupSummary> {
    const rows = await this.database.query<SessionRow>(`
      SELECT session_payload FROM try_on_sessions
      WHERE expires_at <= now() OR deleted_at IS NOT NULL
      ORDER BY expires_at ASC LIMIT 100
    `);
    const summary: CleanupSummary = { examined: rows.length, cleaned: 0, failed: 0 };
    for (const row of rows) {
      const session = row.session_payload;
      try {
        await this.objects.delete(assetKeys(session));
        await this.database.query("DELETE FROM try_on_sessions WHERE id = $1", [session.id]);
        summary.cleaned += 1;
      } catch (error) {
        summary.failed += 1;
        await this.database.query("UPDATE try_on_sessions SET cleanup_error_code = 'CLEANUP_RETRY_REQUIRED', cleanup_attempted_at = now() WHERE id = $1", [session.id]).catch(() => undefined);
        logServerEvent("cleanup.session_failed", { session_id: session.id, error_code: "CLEANUP_RETRY_REQUIRED", error });
      }
    }
    await this.database.query("DELETE FROM rate_limit_buckets WHERE expires_at < now() - interval '1 day'").catch(() => undefined);
    return summary;
  }

  async health(): Promise<{ database: boolean; storage: boolean }> {
    const [database, storage] = await Promise.all([this.database.health(), this.objects.health()]);
    return { database, storage };
  }
}

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionRepository, newSession } from "../src/product/live/repository.js";
import { startLiveGeneration } from "../src/product/live/pipeline.js";
import type { LiveGenerationProvider } from "../src/product/live/provider.js";
import { publicSession, type SessionAsset, type TryOnSession } from "../src/product/live/types.js";
import { normalizeImageUpload, ProductUploadError } from "../src/product/live/uploads.js";
import type { PrivateObjectStore } from "../src/product/production/blob.js";
import { loadProductionConfig } from "../src/product/production/config.js";
import type { DatabaseClient } from "../src/product/production/db.js";
import { redactLogFields } from "../src/product/production/logging.js";
import { hashAnonymousToken, newAnonymousToken } from "../src/product/production/ownership.js";
import { MemoryRateLimiter } from "../src/product/production/rate-limit.js";
import { PostgresBlobSessionRepository } from "../src/product/production/repository.js";
import { mutationOriginAllowed } from "../src/product/production/request-security.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fileRepository(ttl = 24): Promise<{ root: string; repository: FileSessionRepository }> {
  const root = await mkdtemp(join(tmpdir(), "drapeproof-production-")); roots.push(root);
  return { root, repository: new FileSessionRepository(root, ttl) };
}

async function attach(repository: FileSessionRepository, session: TryOnSession, kind: "source" | "product", path: string): Promise<SessionAsset> {
  const normalized = await normalizeImageUpload({ kind, originalName: `${kind}.png`, mediaType: "image/png", bytes: await readFile(path) });
  return repository.writeAsset(session.id, normalized.asset, normalized.bytes);
}

class FakeDatabase implements DatabaseClient {
  constructor(private readonly session?: TryOnSession, private readonly failure?: Error) {}
  async query<T>(text: string): Promise<T[]> {
    if (this.failure) throw this.failure;
    if (text.includes("SELECT session_payload")) return this.session ? [{ session_payload: this.session } as T] : [];
    return [{ id: this.session?.id ?? "ok" } as T];
  }
  async health(): Promise<boolean> { return !this.failure; }
}

class FakeObjects implements PrivateObjectStore {
  deleted: string[] = [];
  constructor(private readonly fail = false) {}
  async putAsset(): Promise<string> { if (this.fail) throw new Error("storage down"); return "source/opaque.jpg"; }
  async putDerived(): Promise<string> { return "derived/opaque.bin"; }
  async read(): Promise<Uint8Array> { if (this.fail) throw new Error("storage down"); return new Uint8Array([1]); }
  async delete(keys: string[]): Promise<void> { if (this.fail) throw new Error("storage down"); this.deleted.push(...keys); }
  async health(): Promise<boolean> { return !this.fail; }
}

describe("production persistence and authorization", () => {
  it("uses strong random ownership tokens and stable one-way keyed hashes", () => {
    const token = newAnonymousToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashAnonymousToken(token, "secret-a")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashAnonymousToken(token, "secret-a")).toBe(hashAnonymousToken(token, "secret-a"));
    expect(hashAnonymousToken(token, "secret-a")).not.toBe(hashAnonymousToken(token, "secret-b"));
    expect(hashAnonymousToken(token, "secret-a")).not.toContain(token);
  });

  it("persists owner-isolated sessions across repository instances and enforces expiration", async () => {
    const { root, repository } = await fileRepository();
    const ownerA = hashAnonymousToken(newAnonymousToken()); const ownerB = hashAnonymousToken(newAnonymousToken());
    const session = await repository.create(ownerA);
    expect((await new FileSessionRepository(root).getOwned(session.id, ownerA))?.id).toBe(session.id);
    expect(await repository.getOwned(session.id, ownerB)).toBeNull();
    session.expiresAt = new Date(Date.now() - 1_000).toISOString(); await repository.save(session);
    expect(await repository.getOwned(session.id, ownerA)).toBeNull();
  });

  it("deletes local assets idempotently while revealing nothing to another owner", async () => {
    const { repository } = await fileRepository(); const session = await repository.create("owner-a");
    session.sourceImage = await attach(repository, session, "source", resolve("web/public/product/sample-original.png")); await repository.save(session);
    expect(await repository.delete(session.id, "owner-b")).toBe(false);
    expect(await repository.delete(session.id, "owner-a")).toBe(true);
    expect(await repository.delete(session.id, "owner-a")).toBe(true);
    expect(await repository.get(session.id)).toBeNull();
  });

  it("atomically deduplicates generation starts and persists the resumable provider task", async () => {
    const { root, repository } = await fileRepository(); const session = await repository.create("owner-a");
    session.category = "CLOTHING";
    session.sourceImage = await attach(repository, session, "source", resolve("web/public/product/sample-original.png"));
    session.productImage = await attach(repository, session, "product", resolve("web/public/product/sample-garment.png"));
    await repository.save(session);
    let starts = 0;
    const provider: LiveGenerationProvider = {
      async start() { starts += 1; await new Promise((done) => setTimeout(done, 20)); return { taskId: "durable-task", product: "AI Clothes Virtual Try-On", version: "Clothes V4.0" }; },
      async poll() { return { state: "RUNNING" }; },
    };
    const first = (await repository.get(session.id))!; const duplicate = (await repository.get(session.id))!;
    await Promise.all([startLiveGeneration(first, repository, provider, "same-attempt"), startLiveGeneration(duplicate, repository, provider, "same-attempt")]);
    expect(starts).toBe(1);
    const restarted = await new FileSessionRepository(root).get(session.id);
    expect(restarted?.provider).toMatchObject({ state: "RUNNING", phase: "PROVIDER_SUBMITTED", taskId: "durable-task", idempotencyKey: "same-attempt" });
  });

  it("deletes every tracked private Blob key and rejects database/storage failures", async () => {
    const session = newSession("owner-a");
    session.sourceImage = { kind: "source", filename: "source.jpg", storageKey: "source/a.jpg", mediaType: "image/jpeg", width: 512, height: 512, size: 10 };
    const sourceAsset = session.sourceImage;
    session.providerResult = { kind: "result", filename: "result.jpg", storageKey: "provider-result/b.jpg", mediaType: "image/jpeg", width: 512, height: 512, size: 10 };
    session.derivedBlobKeys = ["derived/c.json"];
    const objects = new FakeObjects(); const repository = new PostgresBlobSessionRepository(new FakeDatabase(session), objects, 24);
    expect(await repository.delete(session.id, session.ownerId)).toBe(true);
    expect(objects.deleted.sort()).toEqual(["derived/c.json", "provider-result/b.jpg", "source/a.jpg"]);
    await expect(new PostgresBlobSessionRepository(new FakeDatabase(undefined, new Error("db down")), objects, 24).create("owner")).rejects.toThrow("db down");
    await expect(new PostgresBlobSessionRepository(new FakeDatabase(session), new FakeObjects(true), 24).writeAsset(session.id, sourceAsset, new Uint8Array([1]))).rejects.toThrow("storage down");
  });

  it("never serializes private ownership, task, object, or derived metadata", () => {
    const session = newSession("private-owner-hash");
    session.sourceImage = { kind: "source", filename: "source.jpg", storageKey: "source/private.jpg", mediaType: "image/jpeg", width: 512, height: 512, size: 10 };
    session.provider.taskId = "private-provider-task"; session.provider.idempotencyKey = "private-attempt";
    session.faceAppearance = { enabled: true, state: "CHECKING", taskIds: { original: "a", control: "b", result: "c" } };
    session.derivedBlobKeys = ["derived/private.json"];
    expect(JSON.stringify(publicSession(session))).not.toMatch(/private-owner|private-provider|private-attempt|source\/private|derived\/private|"taskIds"/);
  });
});

describe("production controls", () => {
  it("validates declared MIME, extension, decoded format, and strips original filenames", async () => {
    const png = await readFile(resolve("web/public/product/sample-garment.png"));
    await expect(normalizeImageUpload({ kind: "product", originalName: "look.jpg", mediaType: "image/jpeg", bytes: png })).rejects.toBeInstanceOf(ProductUploadError);
    const normalized = await normalizeImageUpload({ kind: "product", originalName: "personal-name.png", mediaType: "image/png", bytes: png });
    expect(normalized.asset).not.toHaveProperty("originalName");
    expect(normalized.asset.filename).not.toContain("personal-name");
  });

  it("rate limits by scope and returns a bounded retry window", async () => {
    const limiter = new MemoryRateLimiter();
    expect((await limiter.check("generation", "owner", 2, 60)).allowed).toBe(true);
    expect((await limiter.check("generation", "owner", 2, 60)).allowed).toBe(true);
    const blocked = await limiter.check("generation", "owner", 2, 60);
    expect(blocked.allowed).toBe(false); expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("rejects cross-origin production mutations", () => {
    expect(mutationOriginAllowed({ origin: "https://app.example", host: "app.example", fetchSite: "same-origin", production: true })).toBe(true);
    expect(mutationOriginAllowed({ origin: "https://evil.example", host: "app.example", fetchSite: "cross-site", production: true })).toBe(false);
    expect(mutationOriginAllowed({ origin: null, host: "app.example", fetchSite: null, production: true })).toBe(false);
  });

  it("redacts secrets, tokens, cookies, image bytes, and signed URLs from structured logs", () => {
    const redacted = redactLogFields({ apiKey: "secret", cookie: "owner", imageBytes: "raw", message: "failed https://private.example/a?sig=secret", nested: { token: "x" } });
    expect(JSON.stringify(redacted)).not.toMatch(/secret|owner|raw|sig=/);
    expect(redacted).toMatchObject({ apiKey: "[REDACTED]", cookie: "[REDACTED]", imageBytes: "[REDACTED]" });
  });

  it("fails production configuration without server-only secrets", () => {
    expect(() => loadProductionConfig({ NODE_ENV: "production" })).toThrow(/YOUCAM_API_KEY.*DATABASE_URL.*BLOB_READ_WRITE_TOKEN.*DRAPEPROOF_OWNER_HASH_SECRET.*CRON_SECRET/);
  });

  it("contains the migration, private cache, noindex, security-header, cleanup, smoke, and file-share contracts", async () => {
    const [migration, nextConfig, robots, assetRoute, share, scripts] = await Promise.all([
      readFile(resolve("migrations/0001_m6_production.sql"), "utf8"),
      readFile(resolve("web/next.config.ts"), "utf8"),
      readFile(resolve("web/app/robots.ts"), "utf8"),
      readFile(resolve("web/app/api/sessions/[id]/asset/[kind]/route.ts"), "utf8"),
      readFile(resolve("web/src/components/product/passport-actions.tsx"), "utf8"),
      Promise.all(["scripts/cleanup-expired.ts", "scripts/smoke-production.ts", "scripts/check-production-paths.ts"].map((path) => readFile(resolve(path), "utf8"))).then((values) => values.join("\n")),
    ]);
    expect(migration).toMatch(/anonymous_owner_hash|expires_at|provider_idempotency_key|rate_limit_buckets/);
    expect(migration.match(/CREATE INDEX|CREATE UNIQUE INDEX/g)?.length).toBeGreaterThanOrEqual(5);
    expect(nextConfig).toMatch(/Content-Security-Policy|Referrer-Policy|X-Content-Type-Options|Permissions-Policy|private, no-store/);
    expect(robots).toMatch(/\/try|\/session|\/result|\/passport/);
    expect(assetRoute).toMatch(/ownedSession|privateHeaders/);
    expect(share).toMatch(/files: \[file\]/); expect(share).not.toMatch(/window\.location|clipboard|url\s*:/);
    expect(scripts).toMatch(/cleanupExpired|--live-provider|Local path leakage/);
  });
});

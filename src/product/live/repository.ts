import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { sessionTtlHours } from "../production/config.js";
import type { SessionAsset, SessionPreservationAttempt, TryOnSession } from "./types.js";

export interface CleanupSummary { examined: number; cleaned: number; failed: number; }

export interface SessionRepository {
  create(ownerHash: string): Promise<TryOnSession>;
  get(id: string): Promise<TryOnSession | null>;
  getOwned(id: string, ownerHash: string): Promise<TryOnSession | null>;
  save(session: TryOnSession): Promise<void>;
  list(ownerHash: string): Promise<TryOnSession[]>;
  delete(id: string, ownerHash: string): Promise<boolean>;
  claimGeneration(session: TryOnSession): Promise<boolean>;
  claimPreservation(session: TryOnSession, attempt: SessionPreservationAttempt): Promise<"CLAIMED" | "DUPLICATE" | "BUSY">;
  completePreservation(session: TryOnSession, attempt: SessionPreservationAttempt): Promise<void>;
  clearPreservation(id: string, ownerHash: string): Promise<void>;
  writeAsset(id: string, asset: SessionAsset, bytes: Uint8Array): Promise<SessionAsset>;
  readAsset(id: string, asset: SessionAsset): Promise<Uint8Array>;
  deleteAssets(id: string, assets: Array<SessionAsset | null>): Promise<void>;
  deleteDerived(id: string, keys: string[]): Promise<void>;
  materializeAsset(id: string, asset: SessionAsset): Promise<string>;
  persistDerived(id: string, directory: string): Promise<string[]>;
  assetPath(id: string, asset: SessionAsset): string;
  sessionDirectory(id: string): string;
  cleanupExpired(): Promise<CleanupSummary>;
  health(): Promise<{ database: boolean; storage: boolean }>;
}

export function newSession(ownerHash: string, ttlHours = sessionTtlHours()): TryOnSession {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0", id: randomUUID(), ownerId: ownerHash, createdAt: now, updatedAt: now,
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1_000).toISOString(),
    category: null, sourceImage: null, productImage: null, providerResult: null, preservedResult: null, passportImage: null,
    preservationVersion: 0, preservationAttempts: [],
    protectedRegions: [],
    provider: { state: "NOT_STARTED", product: "AI Clothes Virtual Try-On", version: "Clothes V4.0" },
    continuity: { state: "NOT_CHECKED", localVerificationEligible: false, reasonCodes: [], signals: [] },
    protectedRegionResults: [], faceAppearance: { state: "NOT_CHECKED", enabled: false },
    derivedBlobKeys: [], cleanupFailures: [], stage: "PHOTO", finalState: "PROCESSING", deletedAt: null, qaFixture: null,
  };
}

function assertId(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid session identifier.");
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

export class FileSessionRepository implements SessionRepository {
  private generationLock: Promise<void> = Promise.resolve();
  private readonly preservationLocks = new Set<string>();

  constructor(private readonly root: string, private readonly ttlHours = sessionTtlHours()) {}

  sessionDirectory(id: string): string {
    assertId(id);
    const directory = resolve(this.root, id);
    if (!directory.startsWith(`${resolve(this.root)}${sep}`)) throw new Error("Session path escaped the persistence root.");
    return directory;
  }

  private recordPath(id: string): string { return resolve(this.sessionDirectory(id), "session.json"); }

  private async raw(id: string): Promise<TryOnSession | null> {
    try {
      const value = JSON.parse(await readFile(this.recordPath(id), "utf8")) as TryOnSession;
      if (value.schemaVersion !== "1.0" || value.id !== id) throw new Error("Malformed session record.");
      value.passportImage ??= null; value.preservedResult ??= null; value.preservationVersion ??= 0; value.preservationAttempts ??= [];
      value.qaFixture ??= null;
      value.derivedBlobKeys ??= []; value.cleanupFailures ??= [];
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async create(ownerHash: string): Promise<TryOnSession> {
    const session = newSession(ownerHash, this.ttlHours);
    await this.save(session);
    return session;
  }

  async get(id: string): Promise<TryOnSession | null> {
    const value = await this.raw(id);
    if (!value || value.deletedAt) return null;
    if (Date.parse(value.expiresAt) <= Date.now()) {
      await this.delete(value.id, value.ownerId);
      return null;
    }
    return value;
  }

  async getOwned(id: string, ownerHash: string): Promise<TryOnSession | null> {
    const session = await this.get(id);
    return session?.ownerId === ownerHash ? session : null;
  }

  async save(session: TryOnSession): Promise<void> {
    const directory = this.sessionDirectory(session.id);
    await mkdir(directory, { recursive: true });
    session.updatedAt = new Date().toISOString();
    const temporary = resolve(directory, `session-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.recordPath(session.id));
  }

  async list(ownerHash: string): Promise<TryOnSession[]> {
    await mkdir(this.root, { recursive: true });
    const sessions: TryOnSession[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const session = await this.get(entry.name);
      if (session?.ownerId === ownerHash) sessions.push(session);
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async delete(id: string, ownerHash: string): Promise<boolean> {
    const session = await this.raw(id);
    if (!session || session.ownerId !== ownerHash) return false;
    if (session.deletedAt) return true;
    const target = this.sessionDirectory(id);
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) throw new Error("Session deletion target is not a directory.");
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.name === "session.json") continue;
      await rm(resolve(target, entry.name), { recursive: true, force: true });
    }
    session.deletedAt = new Date().toISOString();
    session.sourceImage = null; session.productImage = null; session.providerResult = null; session.preservedResult = null; session.passportImage = null;
    session.preservationAttempts = []; session.preservationVersion = 0;
    session.derivedBlobKeys = [];
    await this.save(session);
    return true;
  }

  async claimGeneration(session: TryOnSession): Promise<boolean> {
    let release!: () => void;
    const previous = this.generationLock;
    this.generationLock = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      const current = await this.get(session.id);
      if (!current || current.provider.state !== "NOT_STARTED") return false;
      await this.save(session);
      return true;
    } finally { release(); }
  }

  async claimPreservation(session: TryOnSession, attempt: SessionPreservationAttempt): Promise<"CLAIMED" | "DUPLICATE" | "BUSY"> {
    const current = await this.getOwned(session.id, session.ownerId);
    if (!current) return "BUSY";
    if (current.preservationAttempts.some((item) => item.regionId === attempt.regionId && item.idempotencyKey === attempt.idempotencyKey)) return "DUPLICATE";
    if (current.preservationVersion !== attempt.inputVersion || this.preservationLocks.has(session.id) || current.preservationAttempts.some((item) => item.state === "PROCESSING")) return "BUSY";
    this.preservationLocks.add(session.id);
    current.preservationAttempts.push(attempt);
    await this.save(current);
    return "CLAIMED";
  }

  async completePreservation(session: TryOnSession, attempt: SessionPreservationAttempt): Promise<void> {
    try {
      const index = session.preservationAttempts.findIndex((item) => item.id === attempt.id);
      if (index >= 0) session.preservationAttempts[index] = attempt;
      else session.preservationAttempts.push(attempt);
      await this.save(session);
    } finally { this.preservationLocks.delete(session.id); }
  }

  async clearPreservation(_id: string, _ownerHash: string): Promise<void> { /* session.json is authoritative locally */ }

  async writeAsset(id: string, asset: SessionAsset, bytes: Uint8Array): Promise<SessionAsset> {
    const directory = this.sessionDirectory(id);
    await mkdir(directory, { recursive: true });
    const safeFilename = basename(asset.filename);
    if (safeFilename !== asset.filename) throw new Error("Invalid asset filename.");
    await writeFile(resolve(directory, safeFilename), bytes, { flag: "w" });
    const { storageKey: _storageKey, ...localAsset } = asset;
    return localAsset;
  }

  async readAsset(id: string, asset: SessionAsset): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.assetPath(id, asset)));
  }

  async deleteAssets(id: string, assets: Array<SessionAsset | null>): Promise<void> {
    await Promise.all(assets.filter((asset): asset is SessionAsset => Boolean(asset)).map((asset) => rm(this.assetPath(id, asset), { force: true })));
  }

  async deleteDerived(id: string, keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => {
      const candidate = resolve(this.sessionDirectory(id), key);
      if (!candidate.startsWith(`${this.sessionDirectory(id)}${sep}`)) throw new Error("Derived path escaped the session root.");
      return rm(candidate, { recursive: true, force: true });
    }));
  }

  materializeAsset(id: string, asset: SessionAsset): Promise<string> { return Promise.resolve(this.assetPath(id, asset)); }

  async persistDerived(id: string, directory: string): Promise<string[]> {
    const sessionRoot = this.sessionDirectory(id);
    const paths = await filesRecursively(directory);
    return paths.map((path) => relative(sessionRoot, path).replaceAll("\\", "/"));
  }

  assetPath(id: string, asset: SessionAsset): string { return resolve(this.sessionDirectory(id), basename(asset.filename)); }

  async cleanupExpired(): Promise<CleanupSummary> {
    await mkdir(this.root, { recursive: true });
    const summary: CleanupSummary = { examined: 0, cleaned: 0, failed: 0 };
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      try {
        const session = await this.raw(entry.name); if (!session) continue;
        if (!session.deletedAt && Date.parse(session.expiresAt) > Date.now()) continue;
        summary.examined += 1;
        await rm(this.sessionDirectory(entry.name), { recursive: true, force: true });
        summary.cleaned += 1;
      } catch { summary.failed += 1; }
    }
    return summary;
  }

  async health(): Promise<{ database: boolean; storage: boolean }> {
    try { await mkdir(this.root, { recursive: true }); return { database: true, storage: true }; }
    catch { return { database: false, storage: false }; }
  }
}

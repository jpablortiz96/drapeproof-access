import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { measureRegion } from "../src/verification/metrics.js";
import { evaluatePolicy, readPolicy } from "../src/verification/policy.js";
import { createRegionMask } from "../src/verification/regions.js";
import type { ProtectedRegion, RawImage } from "../src/verification/types.js";
import { hydratePreservationEligibility, preserveRegion, PreservationError } from "../src/product/live/preservation.js";
import { FileSessionRepository } from "../src/product/live/repository.js";
import { publicSession, type SessionAsset, type TryOnSession } from "../src/product/live/types.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

const region: ProtectedRegion = { id: "external-control", label: "Chair control", polygon: [{ x: .06, y: .72 }, { x: .19, y: .72 }, { x: .19, y: .86 }, { x: .06, y: .86 }] };
const landmarks = [
  ["left-shoulder", .42, .24], ["right-shoulder", .58, .24], ["left-elbow", .39, .36], ["right-elbow", .61, .36],
  ["left-wrist", .37, .47], ["right-wrist", .63, .47], ["left-hip", .44, .56], ["right-hip", .56, .56],
].map(([name, x, y], index) => ({ index, name, x, y, visibility: 1, presence: 1 }));

function images(): { source: RawImage; provider: RawImage } {
  const width = 256, height = 256, data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3; data[offset] = 45 + x % 80; data[offset + 1] = 65 + y % 80; data[offset + 2] = 90;
  }
  const source = { data, width, height, channels: 3 as const }; const provider = { ...source, data: Buffer.from(data) };
  const regionMask = createRegionMask(region, width, height);
  for (let pixel = 0; pixel < regionMask.length; pixel += 1) if (regionMask[pixel]) {
    const offset = pixel * 3; provider.data[offset] = 245; provider.data[offset + 1] = 20; provider.data[offset + 2] = 180;
  }
  for (let y = 42; y < 145; y += 1) for (let x = 88; x < 168; x += 1) {
    const offset = (y * width + x) * 3; provider.data[offset] = 20; provider.data[offset + 1] = 35; provider.data[offset + 2] = 160;
  }
  return { source, provider };
}

async function png(image: RawImage): Promise<Buffer> {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } }).png().toBuffer();
}

async function fixture(continuity = true): Promise<{ repository: FileSessionRepository; session: TryOnSession; sourceBytes: Buffer; providerBytes: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), "drapeproof-preserve-mode-")); roots.push(root);
  const repository = new FileSessionRepository(root); const session = await repository.create("owner-m8b");
  const value = images(); const sourceBytes = await png(value.source), providerBytes = await png(value.provider);
  const asset = (kind: SessionAsset["kind"], name: string, bytes: Buffer): SessionAsset => ({ kind, filename: name, mediaType: "image/png", width: 256, height: 256, size: bytes.byteLength });
  session.sourceImage = await repository.writeAsset(session.id, asset("source", "source.png", sourceBytes), sourceBytes);
  session.providerResult = await repository.writeAsset(session.id, asset("result", "result.png", providerBytes), providerBytes);
  session.category = "CLOTHING"; session.provider = { state: "SUCCESS", product: "AI Clothes Virtual Try-On", version: "Clothes V4.0" };
  session.protectedRegions = [region];
  session.continuity = {
    state: continuity ? "CONSISTENT" : "CHANGED_TOO_MUCH", localVerificationEligible: continuity, reasonCodes: continuity ? [] : ["POSE_GEOMETRY_SHIFT"],
    signals: [
      { key: "features", status: continuity ? "PASS" : "FAIL", reasonCodes: [], raw: { geometric_inliers: 120, inlier_ratio: .98 } },
      { key: "regions", status: continuity ? "PASS" : "FAIL", reasonCodes: [], raw: { mapping_model: continuity ? "UNIFORM_NORMALIZED_COORDINATES" : null } },
      { key: "pose", status: continuity ? "PASS" : "FAIL", reasonCodes: [], raw: { preservation_pose: { implementation: "MediaPipe Pose Landmarker", model: { name: "Pose landmarker", sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a" }, poses_detected: 1, landmarks } } },
    ],
  };
  const policy = await readPolicy(resolve("config/preservation-policy.json")); const mask = createRegionMask(region, 256, 256);
  const measurements = measureRegion(value.source, value.provider, mask, policy.pixel_tolerance_8bit, policy.sobel_edge_threshold_normalized).measurements;
  session.protectedRegionResults = [{ id: region.id, label: region.label, state: evaluatePolicy(measurements, policy).decision, measurements, artifactDirectory: "test" }];
  session.stage = "COMPLETE"; session.finalState = "READY_WITH_REVIEW"; await repository.save(session);
  return { repository, session, sourceBytes, providerBytes };
}

describe("consumer Preserve Mode", () => {
  it("computes intent-aware eligibility on the server and never trusts a client eligibility value", async () => {
    const { repository, session } = await fixture();
    await hydratePreservationEligibility(session, repository);
    expect(session.protectedRegionResults[0]).toMatchObject({ repairEligibility: "ELIGIBLE", repairState: "NOT_REQUESTED" });
    const actionSource = await readFile(resolve("web/src/server/session-actions.ts"), "utf8");
    const route = actionSource.slice(actionSource.indexOf("function validToken"));
    expect(route).not.toMatch(/body\.eligibility|clientEligibility/);
    expect(route).toMatch(/ownedSession|requireMutationOrigin|enforceRateLimit/);
  });

  it("creates a separate accepted derivative, re-verifies it, rebuilds Passport V2, and consumes zero provider units", async () => {
    const { repository, session, providerBytes } = await fixture();
    await hydratePreservationEligibility(session, repository);
    const updated = await preserveRegion({ session, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-accepted-attempt" });
    expect(updated.providerResult).not.toBeNull(); expect(await repository.readAsset(updated.id, updated.providerResult!)).toEqual(new Uint8Array(providerBytes));
    expect(updated.preservedResult).not.toBeNull(); expect(updated.preservationVersion).toBe(1); expect(updated.passportImage).not.toBeNull();
    expect(updated.protectedRegionResults[0]).toMatchObject({ state: "PRESERVED", repairEligibility: "ELIGIBLE", repairState: "RESTORED" });
    expect(updated.preservationAttempts[0]).toMatchObject({ state: "RESTORED", providerCalls: 0, youcamUnits: 0, outputVersion: 1 });
    expect(updated.preservationAttempts[0]!.trace).toMatchObject({ provider_result_immutable: true, provider_calls: 0, youcam_units: 0 });
    expect(updated.derivedBlobKeys.length).toBeGreaterThan(5);
  });

  it("returns an existing attempt for a duplicate idempotency token and rejects a stale version for a new attempt", async () => {
    const { repository, session } = await fixture(); await hydratePreservationEligibility(session, repository);
    const first = await preserveRegion({ session, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-idempotent-attempt" });
    const duplicate = await preserveRegion({ session: first, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-idempotent-attempt" });
    expect(duplicate.preservationAttempts).toHaveLength(1);
    await expect(preserveRegion({ session: first, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-new-stale-attempt" })).rejects.toMatchObject({ code: "PRESERVE_VERSION_CONFLICT" });
  });

  it("serializes concurrent derivative mutations so only one version-zero attempt can commit", async () => {
    const { repository, session } = await fixture(); await hydratePreservationEligibility(session, repository); await repository.save(session);
    const first = (await repository.get(session.id))!, second = (await repository.get(session.id))!;
    const outcomes = await Promise.allSettled([
      preserveRegion({ session: first, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-concurrent-first" }),
      preserveRegion({ session: second, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-concurrent-second" }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    const current = (await repository.get(session.id))!;
    expect(current.preservationVersion).toBe(1); expect(current.preservationAttempts).toHaveLength(1);
  });

  it("blocks continuity failure without producing a derivative", async () => {
    const { repository, session } = await fixture(false); await hydratePreservationEligibility(session, repository);
    expect(session.protectedRegionResults[0]!.repairEligibility).toBe("BLOCKED_CONTINUITY");
    const updated = await preserveRegion({ session, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-continuity-block" });
    expect(updated.preservedResult).toBeNull(); expect(updated.preservationVersion).toBe(0);
    expect(updated.preservationAttempts[0]).toMatchObject({ state: "BLOCKED", eligibility: "BLOCKED_CONTINUITY", providerCalls: 0, youcamUnits: 0 });
  });

  it("keeps ownership, object keys, idempotency tokens, and private artifact keys out of the public session", async () => {
    const { repository, session } = await fixture(); await hydratePreservationEligibility(session, repository);
    const updated = await preserveRegion({ session, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-private-attempt" });
    const serialized = JSON.stringify(publicSession(updated));
    expect(serialized).not.toMatch(/owner-m8b|m8b-private-attempt|storageKey|derived\/|repair\//);
    expect(serialized).toMatch(/PRESERVE_ENGINE_V1|UpperBodyPoseIntentZoneV1|provider_result_immutable/);
  });

  it("deletes accepted preservation assets and traces with the owning session", async () => {
    const { repository, session } = await fixture(); await hydratePreservationEligibility(session, repository);
    const updated = await preserveRegion({ session, repository, regionId: region.id, inputVersion: 0, idempotencyKey: "m8b-delete-attempt" });
    expect(await repository.delete(updated.id, "not-owner")).toBe(false);
    expect(await repository.delete(updated.id, updated.ownerId)).toBe(true);
    expect(await repository.get(updated.id)).toBeNull();
  });

  it("keeps provider budget at zero throughout the runtime and UI", async () => {
    const [runtime, actionSource, result, migration] = await Promise.all([
      readFile(resolve("src/product/live/preservation.ts"), "utf8"), readFile(resolve("web/src/server/session-actions.ts"), "utf8"),
      readFile(resolve("web/src/components/product/result-view.tsx"), "utf8"), readFile(resolve("migrations/0002_m8b_preserve_mode.sql"), "utf8"),
    ]);
    const route = actionSource.slice(actionSource.indexOf("function validToken"));
    expect(`${runtime}\n${route}`).not.toMatch(/YouCamLiveGenerationProvider|provider\.start|provider\.poll|YOUCAM_API_KEY/);
    expect(`${runtime}\n${route}`).toMatch(/providerCalls: 0|provider_calls: 0/); expect(`${runtime}\n${route}`).toMatch(/youcamUnits: 0|youcam_units: 0/);
    expect(result).toMatch(/Nothing is restored automatically|Restore from original|provider result remains available and unchanged/i);
    expect(migration).toMatch(/preservation_attempts|UNIQUE \(session_id, region_id, idempotency_key\)|ON DELETE CASCADE/);
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionRepository } from "../src/product/live/repository.js";
import { advanceLiveSession, routeAfterContinuity, startLiveGeneration } from "../src/product/live/pipeline.js";
import { renderPassportPng } from "../src/product/live/passport.js";
import { normalizeImageUpload, ProductUploadError } from "../src/product/live/uploads.js";
import { publicSession } from "../src/product/live/types.js";
import type { LiveGenerationProvider } from "../src/product/live/provider.js";
import { continuityHeadline, continuityReason } from "../web/src/lib/consumer-language.js";

const temporaryRoots: string[] = [];
afterEach(async () => { while (temporaryRoots.length) await rm(temporaryRoots.pop()!, { recursive: true, force: true }); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "drapeproof-product-"));
  temporaryRoots.push(root);
  return new FileSessionRepository(root);
}

async function upload(repo: FileSessionRepository, id: string, kind: "source" | "product", path: string) {
  const bytes = await readFile(path);
  const normalized = await normalizeImageUpload({ kind, originalName: `${kind}.png`, mediaType: "image/png", bytes });
  return repo.writeAsset(id, normalized.asset, normalized.bytes);
}

describe("live product engine", () => {
  it("persists isolated anonymous sessions and deletes all locally controlled data", async () => {
    const repo = await repository();
    const first = await repo.create("browser-a");
    await repo.create("browser-b");
    expect((await repo.list("browser-a")).map((item) => item.id)).toEqual([first.id]);
    expect(await repo.delete(first.id, "browser-b")).toBe(false);
    expect(await repo.delete(first.id, "browser-a")).toBe(true);
    expect(await repo.get(first.id)).toBeNull();
  });

  it("never exposes owner identity or provider task identifiers to clients", async () => {
    const repo = await repository();
    const session = await repo.create("private-owner");
    session.provider.taskId = "private-provider-task";
    const publicValue = publicSession(session);
    expect(publicValue).not.toHaveProperty("ownerId");
    expect(publicValue.provider).not.toHaveProperty("taskId");
    expect(JSON.stringify(publicValue)).not.toContain("private-");
  });

  it("validates uploads and rejects unsupported or undersized images", async () => {
    await expect(normalizeImageUpload({ kind: "source", originalName: "x.gif", mediaType: "image/gif", bytes: new Uint8Array([1]) })).rejects.toBeInstanceOf(ProductUploadError);
    const tiny = await readFile(resolve("web/public/product/sample-bag.png"));
    await expect(normalizeImageUpload({ kind: "source", originalName: "tiny.png", mediaType: "image/png", bytes: tiny.subarray(0, 10) })).rejects.toBeInstanceOf(ProductUploadError);
  });

  it("starts and advances a real provider-shaped task without leaking provider work into the browser", async () => {
    const repo = await repository();
    const session = await repo.create("browser-a");
    session.category = "CLOTHING";
    session.sourceImage = await upload(repo, session.id, "source", resolve("web/public/product/sample-original.png"));
    session.productImage = await upload(repo, session.id, "product", resolve("web/public/product/sample-garment.png"));
    const generated = await readFile(resolve("web/public/product/sample-result.jpg"));
    const provider: LiveGenerationProvider = {
      async start() { return { taskId: "server-task", product: "AI Clothes Virtual Try-On", version: "Clothes V4.0" }; },
      async poll() { return { state: "SUCCESS", result: { bytes: generated, mediaType: "image/jpeg" } }; },
    };
    await startLiveGeneration(session, repo, provider);
    expect(session).toMatchObject({ stage: "CREATING", provider: { state: "RUNNING", taskId: "server-task" } });
    await advanceLiveSession(session, repo, provider);
    expect(session).toMatchObject({ stage: "CONTINUITY", provider: { state: "SUCCESS" }, continuity: { state: "CHECKING" } });
    expect(session.providerResult?.filename).toBe("result.jpg");
  });

  it("turns provider failures into an honest recoverable product state", async () => {
    const repo = await repository();
    const session = await repo.create("browser-a");
    session.category = "BAG";
    session.stage = "CREATING";
    session.provider = { state: "RUNNING", product: "AI Bag Virtual Try-On", version: "Bag Virtual Try-On V2.0", taskId: "task" };
    const provider: LiveGenerationProvider = {
      async start() { throw new Error("unused"); },
      async poll() { return { state: "FAILED", error: "The service could not create this preview." }; },
    };
    await advanceLiveSession(session, repo, provider);
    expect(session).toMatchObject({ stage: "FAILED", finalState: "PROVIDER_FAILED", provider: { state: "FAILED" } });
  });

  it("turns stalled provider work into a plain-language timeout state", async () => {
    const repo = await repository();
    const session = await repo.create("browser-a");
    session.category = "CLOTHING";
    session.stage = "CREATING";
    session.provider = { state: "RUNNING", product: "AI Clothes Virtual Try-On", version: "Clothes V4.0", taskId: "task", startedAt: new Date(Date.now() - 6 * 60 * 1_000).toISOString() };
    let polled = false;
    const provider: LiveGenerationProvider = {
      async start() { throw new Error("unused"); },
      async poll() { polled = true; return { state: "RUNNING" }; },
    };
    await advanceLiveSession(session, repo, provider);
    expect(polled).toBe(false);
    expect(session).toMatchObject({ finalState: "PROVIDER_FAILED", provider: { state: "FAILED" } });
    expect(session.provider.error).toMatch(/taking longer.*start again/i);
  });

  it("blocks local verification after continuity failure and routes eligible sessions correctly", () => {
    expect(routeAfterContinuity(false, 3, true)).toEqual({ stage: "COMPLETE", finalState: "PREVIEW_NOT_VERIFIABLE" });
    expect(routeAfterContinuity(true, 3, false)).toEqual({ stage: "REGIONS" });
    expect(routeAfterContinuity(true, 0, true)).toEqual({ stage: "FACE" });
    expect(routeAfterContinuity(true, 0, false)).toEqual({ stage: "COMPLETE", finalState: "READY_VERIFIED" });
  });

  it("renders an actual downloadable Passport PNG from session data", async () => {
    const repo = await repository();
    const session = await repo.create("browser-a");
    session.category = "CLOTHING";
    session.continuity = { state: "CONSISTENT", localVerificationEligible: true, reasonCodes: [], signals: [] };
    const png = await renderPassportPng(session, resolve("web/public/product/sample-result.jpg"));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.byteLength).toBeGreaterThan(100_000);
  });
});

describe("product contract", () => {
  it("maps engineering states and reason codes to plain product language", () => {
    expect(continuityHeadline("CONSISTENT")).toBe("Scene looks consistent");
    expect(continuityHeadline("CHANGED_TOO_MUCH")).toBe("This preview changed too much");
    expect(continuityReason("POSE_LANDMARK_LOSS")).toMatch(/pose reference points/i);
    expect(continuityReason("UNKNOWN_CODE")).toMatch(/contributed/i);
  });

  it("keeps product navigation free of internal release language", async () => {
    const [shell, home] = await Promise.all([
      readFile(resolve("web/src/components/product/ui.tsx"), "utf8"),
      readFile(resolve("web/app/page.tsx"), "utf8"),
    ]);
    expect(`${shell}\n${home}`).not.toMatch(/judge|replay|hackathon|synthetic test input|PASS_M\d|milestone/i);
  });

  it("keeps provider credentials in server-only code", async () => {
    const files = ["web/app/page.tsx", "web/src/components/product/session-client.ts", "web/src/components/product/review-step.tsx", "web/src/components/product/processing-experience.tsx"];
    const publicCode = (await Promise.all(files.map((file) => readFile(resolve(file), "utf8")))).join("\n");
    const provider = await readFile(resolve("src/product/live/provider.ts"), "utf8");
    expect(publicCode).not.toMatch(/YOUCAM_API_KEY|authorization|api[_-]?key/i);
    expect(provider).toContain("YOUCAM_API_KEY");
  });

  it("implements a keyboard-capable polygon editor and accessible product shell", async () => {
    const [editor, shell, css] = await Promise.all([
      readFile(resolve("web/src/components/product/protected-region-editor.tsx"), "utf8"),
      readFile(resolve("web/src/components/product/ui.tsx"), "utf8"),
      readFile(resolve("web/app/product.css"), "utf8"),
    ]);
    expect(editor).toContain("ArrowLeft");
    expect(editor).toContain("Enter");
    expect(editor).toContain("Undo point");
    expect(editor).toContain("Save area");
    expect(shell).toContain("Skip to main content");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/min-height:\s*48px/);
  });

  it("keeps metrics progressive and failure/result language honest", async () => {
    const [technical, result, passport] = await Promise.all([
      readFile(resolve("web/src/components/product/technical-view.tsx"), "utf8"),
      readFile(resolve("web/src/components/product/result-view.tsx"), "utf8"),
      readFile(resolve("web/src/components/product/passport-card.tsx"), "utf8"),
    ]);
    expect(technical).toContain("TechnicalDisclosure");
    expect(technical).toContain("Raw continuity signals");
    expect(result).toContain("This preview changed too much");
    expect(result).toContain("Protected areas not checked");
    expect(result).toContain("regions={review ? reviewedAreas : []}");
    expect(passport).toContain("Visual verification only");
    expect(passport).not.toMatch(/cryptographic|blockchain|signed/i);
  });

  it("keeps the original on the left and generated result on the right of the comparison", async () => {
    const comparison = await readFile(resolve("web/src/components/product/before-after.tsx"), "utf8");
    expect(comparison).toContain("inset(0 0 0 ${position}%)");
    expect(comparison).toContain('label-before">Original');
    expect(comparison).toContain('label-after">AI result');
  });

});

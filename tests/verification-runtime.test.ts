import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLiveContinuityFromBytes, assertVerificationAssets } from "../src/product/live/continuity.js";
import { productionVerificationWorkerUrl } from "../src/continuity/cv.js";
import { routeAfterContinuity } from "../src/product/live/pipeline.js";
import { sanitizedVerificationError, verificationFailureCode, VerificationRuntimeError } from "../src/product/live/verification-errors.js";
import { withVerificationWorkspace } from "../src/product/live/verification-workspace.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function remoteFixture() {
  const [sourcePose, resultPose, features] = await Promise.all([
    readFile(resolve("tests/fixtures/verification/pose-source.json"), "utf8").then(JSON.parse),
    readFile(resolve("tests/fixtures/verification/pose-generated.json"), "utf8").then(JSON.parse),
    readFile(resolve("tests/fixtures/verification/feature-matches.json"), "utf8").then(JSON.parse),
  ]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  return { ok: true, source_pose: sourcePose, result_pose: resultPose, features, artifacts: [
    "pose-source.jpg", "pose-result.jpg", "feature-matches.jpg", "feature-inliers.jpg",
  ].map((name) => ({ name, media_type: "image/jpeg", base64: jpeg })) };
}

async function inputs() {
  return Promise.all([readFile(resolve("web/public/product/sample-original.png")), readFile(resolve("web/public/product/sample-result.jpg"))]);
}

describe("production verification runtime", () => {
  it("asserts the locked model, policies, worker script, and deployment declarations", async () => {
    await expect(assertVerificationAssets()).resolves.toMatchObject({ workerScriptPresent: true, policyName: "EXPERIMENTAL_CONTINUITY_POLICY_V1" });
    const [vercel, next, route, worker] = await Promise.all([
      readFile(resolve("vercel.json"), "utf8"), readFile(resolve("web/next.config.ts"), "utf8"),
      readFile(resolve("web/app/api/sessions/[id]/route.ts"), "utf8"), readFile(resolve("api/verification-worker.py"), "utf8"),
    ]);
    expect(vercel).toMatch(/api\/verification-worker\.py[\s\S]*models\/continuity\/pose_landmarker_lite\.task[\s\S]*scripts\/continuity_cv\.py/);
    expect(next).toMatch(/outputFileTracingIncludes[\s\S]*continuity-policy\.json[\s\S]*preservation-policy\.json/);
    expect(route).toMatch(/runtime = "nodejs"[\s\S]*maxDuration = 180/);
    expect(worker).toMatch(/tempfile\.mkdtemp[\s\S]*shutil\.rmtree/);
    expect(worker).toContain("MAX_IMAGE_BYTES = 3_000_000");
    expect(await readFile(resolve("requirements.txt"), "utf8")).toContain("opencv-contrib-python-headless==5.0.0.93");
  });

  it("cleans every unique verification workspace in a finally block", async () => {
    let workspace = "";
    await expect(withVerificationWorkspace(async (path) => { workspace = path; await access(path); throw new Error("expected"); })).rejects.toThrow("expected");
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps missing runtimes, assets, inputs, and execution failures precisely without leaking paths", () => {
    const runtime = Object.assign(new Error("spawn python ENOENT"), { code: "ENOENT" });
    expect(verificationFailureCode(runtime)).toBe("VERIFIER_RUNTIME_UNAVAILABLE");
    expect(verificationFailureCode(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe("VERIFIER_ASSET_MISSING");
    expect(verificationFailureCode(new Error("Continuity requires source and result images."))).toBe("VERIFIER_INPUT_UNAVAILABLE");
    expect(verificationFailureCode(new VerificationRuntimeError("VERIFIER_EXECUTION_FAILED", "failed"))).toBe("VERIFIER_EXECUTION_FAILED");
    expect(sanitizedVerificationError(new Error("failed at D:\\private\\source.jpg and /tmp/drapeproof/a"))).not.toMatchObject({ message: expect.stringMatching(/D:\\|\/tmp\//) });
  });

  it("adapts private image bytes to the remote worker and executes continuity with and without protected regions", async () => {
    const root = await mkdtemp(join(tmpdir(), "drapeproof-verification-test-")); roots.push(root);
    const [sourceBytes, resultBytes] = await inputs();
    const remote = await remoteFixture();
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer internal-secret");
      expect(init?.body).not.toContain("internal-secret");
      return Response.json(remote);
    }) as unknown as typeof fetch;
    const env = { DRAPEPROOF_VERIFICATION_WORKER_URL: "https://app.example/api/verification-worker", CRON_SECRET: "internal-secret" };
    const without = await runLiveContinuityFromBytes({ sourceBytes, resultBytes, regions: [], outputRoot: resolve(root, "without"), env, fetchImplementation });
    const definitions = JSON.parse(await readFile(resolve("tests/fixtures/regions/wheelchair-protected.json"), "utf8"));
    const withRegions = await runLiveContinuityFromBytes({ sourceBytes, resultBytes, regions: definitions.regions, outputRoot: resolve(root, "with"), env, fetchImplementation });
    expect(without).toMatchObject({ state: "CONSISTENT", localVerificationEligible: true });
    expect((without.signals.find((signal) => signal.key === "regions")?.raw as { regions: unknown[] }).regions).toHaveLength(0);
    expect(routeAfterContinuity(true, 0, false)).toEqual({ stage: "COMPLETE", finalState: "READY_VERIFIED" });
    expect(withRegions).toMatchObject({ state: "CONSISTENT", localVerificationEligible: true });
    expect((withRegions.signals.find((signal) => signal.key === "regions")?.raw as { regions: unknown[] }).regions).toHaveLength(3);
    expect(routeAfterContinuity(true, 3, false)).toEqual({ stage: "REGIONS" });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("keeps deterministic re-verification provider-free and the production worker secret-gated", async () => {
    const [pipeline, worker, requirements] = await Promise.all([
      readFile(resolve("src/product/live/pipeline.ts"), "utf8"),
      readFile(resolve("api/verification-worker.py"), "utf8"),
      readFile(resolve("requirements.txt"), "utf8"),
    ]);
    const reverificationImplementation = pipeline.slice(pipeline.indexOf("export async function reverifyExistingResult"), pipeline.indexOf("export async function advanceLiveSession"));
    expect(reverificationImplementation).not.toMatch(/provider\.start|provider\.poll|YOUCAM_API_KEY/);
    expect(worker).toMatch(/CRON_SECRET[\s\S]*compare_digest/);
    expect(worker).not.toMatch(/BLOB_READ_WRITE_TOKEN|DATABASE_URL|YOUCAM_API_KEY/);
    expect(requirements).toMatch(/mediapipe==0\.10\.30[\s\S]*opencv-contrib-python-headless==5\.0\.0\.93/);
    expect(productionVerificationWorkerUrl({ DRAPEPROOF_PUBLIC_URL: "https://app.example" })).toBe("https://app.example/api/verification-worker");
  });
});

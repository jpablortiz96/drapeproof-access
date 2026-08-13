import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { VerificationRuntimeError, type VerificationFailureCode } from "../product/live/verification-errors.js";
import { parseFeatureMatches, type RawFeatureMatches } from "./features.js";
import { parsePoseOutput, type RawPoseOutput } from "./pose.js";

async function runWorker(arguments_: string[]): Promise<unknown> {
  const current = resolve(process.cwd());
  const repositoryRoot = existsSync(resolve(current, "scripts/continuity_cv.py")) ? current : resolve(current, "..");
  return new Promise((resolvePromise, reject) => {
    const child = spawn("python", [resolve(repositoryRoot, "scripts/continuity_cv.py"), ...arguments_], { cwd: repositoryRoot, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Continuity CV worker exited ${code}: ${stderr.trim()}`));
      try {
        resolvePromise(JSON.parse(stdout) as unknown);
      } catch (error) {
        reject(new Error(`Continuity CV worker returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

export async function runPoseWorker(options: { imagePath: string; modelPath: string; visualPath: string }): Promise<RawPoseOutput> {
  return parsePoseOutput(await runWorker(["pose", "--image", options.imagePath, "--model", options.modelPath, "--visual", options.visualPath]));
}

export async function runFeatureWorker(options: {
  sourcePath: string;
  generatedPath: string;
  matchesVisualPath: string;
  inliersVisualPath: string;
}): Promise<RawFeatureMatches> {
  return parseFeatureMatches(await runWorker([
    "features", "--source", options.sourcePath, "--generated", options.generatedPath,
    "--matches-visual", options.matchesVisualPath, "--inliers-visual", options.inliersVisualPath,
  ]));
}

interface RemoteArtifact {
  name: "pose-source.jpg" | "pose-result.jpg" | "feature-matches.jpg" | "feature-inliers.jpg";
  media_type: "image/jpeg";
  base64: string;
}

interface RemoteVerificationPayload {
  ok: boolean;
  source_pose?: unknown;
  result_pose?: unknown;
  features?: unknown;
  artifacts?: RemoteArtifact[];
  failure_code?: VerificationFailureCode;
  message?: string;
}

export interface VerificationWorkerResult {
  sourcePose: RawPoseOutput;
  resultPose: RawPoseOutput;
  features: RawFeatureMatches;
}

export function productionVerificationWorkerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DRAPEPROOF_VERIFICATION_WORKER_URL?.trim();
  if (configured) return new URL(configured).toString();
  const origin = env.DRAPEPROOF_PUBLIC_URL?.trim() || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "");
  if (!origin) throw new VerificationRuntimeError("VERIFIER_RUNTIME_UNAVAILABLE", "The production verification worker URL is unavailable.");
  return new URL("/api/verification-worker", origin).toString();
}

function remoteFailureCode(value: unknown): VerificationFailureCode {
  return value === "VERIFIER_RUNTIME_UNAVAILABLE" || value === "VERIFIER_ASSET_MISSING" || value === "VERIFIER_INPUT_UNAVAILABLE" || value === "VERIFIER_EXECUTION_FAILED"
    ? value
    : "VERIFIER_EXECUTION_FAILED";
}

export async function runRemoteVerificationWorkers(options: {
  sourceBytes: Uint8Array;
  resultBytes: Uint8Array;
  outputRoot: string;
  env?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
}): Promise<VerificationWorkerResult> {
  const env = options.env ?? process.env;
  const secret = env.CRON_SECRET?.trim();
  if (!secret) throw new VerificationRuntimeError("VERIFIER_RUNTIME_UNAVAILABLE", "The verification worker credential is unavailable.");
  const request = options.fetchImplementation ?? fetch;
  let response: Response;
  try {
    response = await request(productionVerificationWorkerUrl(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        source_base64: Buffer.from(options.sourceBytes).toString("base64"),
        result_base64: Buffer.from(options.resultBytes).toString("base64"),
      }),
      signal: AbortSignal.timeout(170_000),
    });
  } catch (error) {
    throw new VerificationRuntimeError("VERIFIER_RUNTIME_UNAVAILABLE", "The production verification worker could not be reached.", { cause: error });
  }
  let payload: RemoteVerificationPayload;
  try {
    payload = await response.json() as RemoteVerificationPayload;
  } catch (error) {
    throw new VerificationRuntimeError("VERIFIER_EXECUTION_FAILED", "The production verification worker returned malformed JSON.", { cause: error });
  }
  if (!response.ok || !payload.ok) {
    throw new VerificationRuntimeError(remoteFailureCode(payload.failure_code), payload.message || "The production verification worker failed.");
  }
  if (!payload.source_pose || !payload.result_pose || !payload.features || !Array.isArray(payload.artifacts)) {
    throw new VerificationRuntimeError("VERIFIER_EXECUTION_FAILED", "The production verification worker response was incomplete.");
  }
  await mkdir(options.outputRoot, { recursive: true });
  const allowed = new Set<RemoteArtifact["name"]>(["pose-source.jpg", "pose-result.jpg", "feature-matches.jpg", "feature-inliers.jpg"]);
  const names = new Set<string>();
  for (const artifact of payload.artifacts) {
    if (!allowed.has(artifact.name) || artifact.media_type !== "image/jpeg" || names.has(artifact.name) || !/^[A-Za-z0-9+/]+={0,2}$/.test(artifact.base64)) {
      throw new VerificationRuntimeError("VERIFIER_EXECUTION_FAILED", "The production verification worker returned an invalid artifact.");
    }
    const bytes = Buffer.from(artifact.base64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > 1_500_000) throw new VerificationRuntimeError("VERIFIER_EXECUTION_FAILED", "A production verification artifact had an invalid size.");
    await writeFile(resolve(options.outputRoot, artifact.name), bytes);
    names.add(artifact.name);
  }
  if (names.size !== allowed.size) throw new VerificationRuntimeError("VERIFIER_EXECUTION_FAILED", "The production verification worker omitted a required artifact.");
  return {
    sourcePose: parsePoseOutput(payload.source_pose),
    resultPose: parsePoseOutput(payload.result_pose),
    features: parseFeatureMatches(payload.features),
  };
}

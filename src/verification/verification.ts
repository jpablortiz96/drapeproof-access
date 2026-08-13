import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256File } from "../hash.js";
import { loadAndAlignImages, writeRegionArtifacts } from "./image.js";
import { measureRegion } from "./metrics.js";
import { evaluatePolicy, readPolicy } from "./policy.js";
import { createRegionMask, polygonBounds, readRegionDefinition } from "./regions.js";
import type { PolicyDecision, ProtectedRegion, RegionMeasurements } from "./types.js";

export interface VerificationOutput {
  verificationId: string;
  region: ProtectedRegion;
  decision: PolicyDecision;
  measurements: RegionMeasurements;
  outputDirectory: string;
}

export interface VerifyRegionsOptions {
  originalPath: string;
  generatedPath: string;
  regionsPath: string;
  policyPath: string;
  outputRoot: string;
  timestampUtc?: string;
}

function contentId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}

export async function verifyRegions(options: VerifyRegionsOptions): Promise<VerificationOutput[]> {
  const [definition, policy, originalHash, generatedHash, definitionHash, policyHash, aligned] = await Promise.all([
    readRegionDefinition(options.regionsPath),
    readPolicy(options.policyPath),
    sha256File(options.originalPath),
    sha256File(options.generatedPath),
    sha256File(options.regionsPath),
    sha256File(options.policyPath),
    loadAndAlignImages(options.originalPath, options.generatedPath),
  ]);
  await mkdir(options.outputRoot, { recursive: true });
  const timestampUtc = options.timestampUtc ?? new Date().toISOString();
  const outputs: VerificationOutput[] = [];
  for (const region of definition.regions) {
    const verificationId = `region-${contentId(originalHash, generatedHash, definitionHash, policyHash, region.id)}`;
    const outputDirectory = resolve(options.outputRoot, `${verificationId}-${region.id}`);
    const mask = createRegionMask(region, aligned.original.width, aligned.original.height);
    const measured = measureRegion(
      aligned.original,
      aligned.generated,
      mask,
      policy.pixel_tolerance_8bit,
      policy.sobel_edge_threshold_normalized,
    );
    const policyEvaluation = evaluatePolicy(measured.measurements, policy);
    const artifacts = await writeRegionArtifacts(
      outputDirectory,
      aligned.original,
      aligned.generated,
      region,
      mask,
      measured.artifacts,
    );
    const verification = {
      verification_id: verificationId,
      timestamp_utc: timestampUtc,
      source_m0_run_id: definition.source_run_id ?? null,
      original_file: resolve(options.originalPath),
      generated_file: resolve(options.generatedPath),
      original_sha256: originalHash,
      generated_sha256: generatedHash,
      region_definition_file: resolve(options.regionsPath),
      region_definition_sha256: definitionHash,
      policy_sha256: policyHash,
      alignment: aligned.alignment,
      region: {
        id: region.id,
        label: region.label,
        coordinate_space: "normalized",
        polygon: region.polygon,
        pixel_bounds: polygonBounds(region.polygon, aligned.original.width, aligned.original.height),
        region_pixel_count: measured.measurements.changed_pixel_ratio.total_region_pixels,
      },
      measurements: measured.measurements,
      policy: policyEvaluation,
      decision: policyEvaluation.decision,
      artifacts,
    };
    await writeFile(resolve(outputDirectory, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, { flag: "wx" });
    outputs.push({
      verificationId,
      region,
      decision: policyEvaluation.decision,
      measurements: measured.measurements,
      outputDirectory,
    });
  }
  return outputs;
}

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { sha256File } from "../hash.js";
import { loadAndAlignImages, regionCrop, writeImagePng } from "./image.js";
import { measureRegion } from "./metrics.js";
import { evaluatePolicy, readPolicy } from "./policy.js";
import { createRegionMask, readRegionDefinition } from "./regions.js";
import type { PolicyDecision, RawImage, RegionMeasurements } from "./types.js";

export interface ControlBenchmarkRow {
  mutation: string;
  label: "SYNTHETIC_CONTROL_MUTATION";
  parameters: Record<string, unknown>;
  measurements: RegionMeasurements;
  decision: PolicyDecision;
  artifact: string;
}

function copyImage(image: RawImage): RawImage {
  return { ...image, data: Buffer.from(image.data) };
}

function brightness(image: RawImage, delta: number): RawImage {
  const output = copyImage(image);
  for (let index = 0; index < output.data.length; index += 1) {
    output.data[index] = Math.max(0, Math.min(255, output.data[index]! + delta));
  }
  return output;
}

export function translate(image: RawImage, dx: number, dy: number): RawImage {
  const data = Buffer.alloc(image.data.length, 255);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const targetX = x + dx;
      const targetY = y + dy;
      if (targetX < 0 || targetX >= image.width || targetY < 0 || targetY >= image.height) continue;
      const sourceOffset = (y * image.width + x) * 3;
      const targetOffset = (targetY * image.width + targetX) * 3;
      image.data.copy(data, targetOffset, sourceOffset, sourceOffset + 3);
    }
  }
  return { ...image, data };
}

function rectangleMutation(
  image: RawImage,
  widthFraction: number,
  heightFraction: number,
  color: [number, number, number],
): RawImage {
  const output = copyImage(image);
  const width = Math.max(1, Math.round(image.width * widthFraction));
  const height = Math.max(1, Math.round(image.height * heightFraction));
  const left = Math.floor((image.width - width) / 2);
  const top = Math.floor((image.height - height) / 2);
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const offset = (y * image.width + x) * 3;
      output.data[offset] = color[0];
      output.data[offset + 1] = color[1];
      output.data[offset + 2] = color[2];
    }
  }
  return output;
}

async function jpegReencode(image: RawImage, quality: number): Promise<RawImage> {
  const jpeg = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .jpeg({ quality, chromaSubsampling: "4:2:0", mozjpeg: false })
    .toBuffer();
  const { data, info } = await sharp(jpeg).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("JPEG control did not decode to RGB.");
  return { data, width: info.width, height: info.height, channels: 3 };
}

export interface BuildControlsOptions {
  originalPath: string;
  regionsPath: string;
  regionId: string;
  policyPath: string;
  outputRoot: string;
  timestampUtc?: string;
}

export async function buildControlledBenchmark(options: BuildControlsOptions): Promise<{
  controlId: string;
  outputDirectory: string;
  rows: ControlBenchmarkRow[];
}> {
  const [definition, policy, originalHash, definitionHash, policyHash, aligned] = await Promise.all([
    readRegionDefinition(options.regionsPath),
    readPolicy(options.policyPath),
    sha256File(options.originalPath),
    sha256File(options.regionsPath),
    sha256File(options.policyPath),
    loadAndAlignImages(options.originalPath, options.originalPath),
  ]);
  const region = definition.regions.find((candidate) => candidate.id === options.regionId);
  if (!region) throw new Error(`Control benchmark region not found: ${options.regionId}`);
  const mask = createRegionMask(region, aligned.original.width, aligned.original.height);
  const baseline = regionCrop(aligned.original, region, mask);
  const controlId = `controls-${createHash("sha256").update(`${originalHash}\n${definitionHash}\n${policyHash}\n${region.id}`).digest("hex").slice(0, 20)}`;
  const outputDirectory = resolve(options.outputRoot, controlId);
  await mkdir(outputDirectory, { recursive: false });
  await writeImagePng(resolve(outputDirectory, "baseline.png"), baseline);
  const mutations: Array<{ id: string; parameters: Record<string, unknown>; image: RawImage }> = [
    { id: "no-modification", parameters: { operation: "none" }, image: copyImage(baseline) },
    { id: "jpeg-reencode", parameters: { quality: 85, chroma_subsampling: "4:2:0" }, image: await jpegReencode(baseline, 85) },
    { id: "brightness-plus-15", parameters: { rgb_delta_8bit: 15 }, image: brightness(baseline, 15) },
    { id: "translation-2px", parameters: { dx_pixels: 2, dy_pixels: 0, fill_rgb: [255, 255, 255] }, image: translate(baseline, 2, 0) },
    { id: "translation-5px", parameters: { dx_pixels: 5, dy_pixels: 0, fill_rgb: [255, 255, 255] }, image: translate(baseline, 5, 0) },
    { id: "small-occlusion", parameters: { width_fraction: 0.15, height_fraction: 0.1, fill_rgb: [127, 127, 127] }, image: rectangleMutation(baseline, 0.15, 0.1, [127, 127, 127]) },
    { id: "large-occlusion", parameters: { width_fraction: 0.35, height_fraction: 0.3, fill_rgb: [127, 127, 127] }, image: rectangleMutation(baseline, 0.35, 0.3, [127, 127, 127]) },
    { id: "edge-deletion-mask", parameters: { width_fraction: 0.65, height_fraction: 0.25, fill_rgb: [245, 245, 245] }, image: rectangleMutation(baseline, 0.65, 0.25, [245, 245, 245]) },
  ];
  const cropMask = Buffer.alloc(baseline.width * baseline.height, 1);
  const rows: ControlBenchmarkRow[] = [];
  for (const mutation of mutations) {
    const measured = measureRegion(
      baseline,
      mutation.image,
      cropMask,
      policy.pixel_tolerance_8bit,
      policy.sobel_edge_threshold_normalized,
    );
    const evaluation = evaluatePolicy(measured.measurements, policy);
    const artifact = `${mutation.id}.png`;
    await writeImagePng(resolve(outputDirectory, artifact), mutation.image);
    rows.push({
      mutation: mutation.id,
      label: "SYNTHETIC_CONTROL_MUTATION",
      parameters: mutation.parameters,
      measurements: measured.measurements,
      decision: evaluation.decision,
      artifact,
    });
  }
  const benchmark = {
    control_id: controlId,
    timestamp_utc: options.timestampUtc ?? new Date().toISOString(),
    label: "SYNTHETIC_CONTROL_MUTATION",
    statement: "These controls validate the deterministic verification engine and are not YouCam provider outputs.",
    original_file: resolve(options.originalPath),
    original_sha256: originalHash,
    region_definition_sha256: definitionHash,
    policy_sha256: policyHash,
    region: { id: region.id, label: region.label, polygon: region.polygon },
    baseline_artifact: "baseline.png",
    rows,
  };
  await writeFile(resolve(outputDirectory, "benchmark.json"), `${JSON.stringify(benchmark, null, 2)}\n`, { flag: "wx" });
  return { controlId, outputDirectory, rows };
}

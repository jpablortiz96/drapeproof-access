import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { polygonBounds } from "../verification/regions.js";
import type { PixelBounds, RawImage } from "../verification/types.js";
import type { PreserveAttempt, PreservationTrace } from "./types.js";

function rawInput(image: RawImage) {
  return { raw: { width: image.width, height: image.height, channels: image.channels as 3 } };
}

async function png(path: string, image: RawImage): Promise<void> {
  await sharp(image.data, rawInput(image)).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(path);
}

function paddedBounds(attempt: PreserveAttempt, padding: number): PixelBounds {
  const bounds = polygonBounds(attempt.mapping.target_polygon, attempt.repaired.width, attempt.repaired.height);
  const left = Math.max(0, bounds.left - padding), top = Math.max(0, bounds.top - padding);
  const right = Math.min(attempt.repaired.width, bounds.left + bounds.width + padding);
  const bottom = Math.min(attempt.repaired.height, bounds.top + bounds.height + padding);
  return { left, top, width: right - left, height: bottom - top };
}

async function crop(path: string, image: RawImage, bounds: PixelBounds): Promise<void> {
  await sharp(image.data, rawInput(image)).extract(bounds).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(path);
}

function difference(left: RawImage, right: RawImage): RawImage {
  const data = Buffer.alloc(left.data.length);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.abs(left.data[index]! - right.data[index]!);
  return { ...left, data };
}

function maskVisualization(attempt: PreserveAttempt, mask: Buffer, color: [number, number, number]): RawImage {
  const data = Buffer.from(attempt.repaired.data);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const offset = pixel * 3;
    for (let channel = 0; channel < 3; channel += 1) data[offset + channel] = Math.round(data[offset + channel]! * 0.35 + color[channel]! * 0.65);
  }
  return { ...attempt.repaired, data };
}

function blendVisualization(attempt: PreserveAttempt): RawImage {
  const data = Buffer.from(attempt.input.providerResult.data);
  for (let pixel = 0; pixel < attempt.coreMask.length; pixel += 1) {
    const core = attempt.coreMask[pixel];
    const band = attempt.blendMask[pixel] && !core;
    if (!core && !band) continue;
    const color = core ? [42, 229, 156] : [255, 190, 64];
    const offset = pixel * 3;
    for (let channel = 0; channel < 3; channel += 1) data[offset + channel] = Math.round(data[offset + channel]! * 0.35 + color[channel]! * 0.65);
  }
  return { ...attempt.input.providerResult, data };
}

export async function writePreserveAttemptArtifacts(root: string, attempt: PreserveAttempt, trace: PreservationTrace): Promise<void> {
  await mkdir(root, { recursive: true });
  const bounds = paddedBounds(attempt, 28);
  const beforeDiff = difference(attempt.mappedSource, attempt.input.providerResult);
  const afterDiff = difference(attempt.mappedSource, attempt.repaired);
  await Promise.all([
    crop(resolve(root, "source-crop.png"), attempt.input.source, bounds),
    crop(resolve(root, "provider-generated-crop.png"), attempt.input.providerResult, bounds),
    crop(resolve(root, "mapped-source-crop.png"), attempt.mappedSource, bounds),
    crop(resolve(root, "repaired-crop.png"), attempt.repaired, bounds),
    crop(resolve(root, "before-diff.png"), beforeDiff, bounds),
    crop(resolve(root, "after-diff.png"), afterDiff, bounds),
    crop(resolve(root, "blend-band-visualization.png"), blendVisualization(attempt), bounds),
    png(resolve(root, "full-image-repaired-overlay.png"), maskVisualization(attempt, attempt.coreMask, [42, 229, 156])),
    crop(resolve(root, "outer-safety-ring-visualization.png"), maskVisualization(attempt, attempt.outerRingMask, [62, 170, 255]), bounds),
    png(resolve(root, "repaired-image.png"), attempt.repaired),
  ]);
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="120"><rect width="1000" height="120" fill="#0d171f"/><text x="24" y="48" fill="#ffffff" font-family="Arial" font-size="28">${trace.outcome}</text><text x="24" y="86" fill="#9fb2c3" font-family="Arial" font-size="18">${attempt.input.region.label} · ${attempt.mapping.model} · ${trace.full_image_change_accounting.modified_pixels} pixels modified</text></svg>`)).png().toFile(resolve(root, "outcome-banner.png"));
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function metricLines(trace: PreservationTrace, phase: "initial_verification" | "final_verification"): string[] {
  const snapshot = trace[phase];
  return [
    `MAD ${snapshot.measurements.mean_absolute_difference.normalized.toFixed(6)}`,
    `Changed Ratio ${snapshot.measurements.changed_pixel_ratio.ratio.toFixed(6)}`,
    `SSIM ${snapshot.measurements.ssim.value.toFixed(6)}`,
    `Edge Difference ${snapshot.measurements.edge_difference.ratio.toFixed(6)}`,
    `Decision ${snapshot.decision}`,
  ];
}

export async function writeTraceReportImage(options: {
  path: string;
  title: string;
  middleLabel: string;
  attempt: PreserveAttempt;
  trace: PreservationTrace;
}): Promise<void> {
  const { attempt, trace } = options;
  const bounds = paddedBounds(attempt, 40);
  const panelWidth = 500, panelHeight = 430, imageHeight = 300;
  const panel = async (image: RawImage) => sharp(image.data, rawInput(image)).extract(bounds).resize(panelWidth, imageHeight, { fit: "contain", background: "#111c25" }).png().toBuffer();
  const [source, generated, repaired] = await Promise.all([panel(attempt.input.source), panel(attempt.input.providerResult), panel(attempt.repaired)]);
  const before = metricLines(trace, "initial_verification");
  const after = metricLines(trace, "final_verification");
  const blocked = trace.outcome.startsWith("REPAIR_BLOCKED_") || trace.outcome === "NOT_NEEDED";
  const outputLabel = trace.outcome === "RESTORED" ? "DRAPEPROOF RESTORED" : blocked ? "NO REPAIR APPLIED" : "DRAPEPROOF DERIVATIVE";
  const footer = blocked
    ? "No repair applied. Provider result retained. Re-verified independently."
    : "Restored from source. No generative reconstruction. Re-verified independently.";
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1050">
    <rect width="1600" height="1050" fill="#071219"/>
    <text x="60" y="70" fill="#ffffff" font-family="Arial" font-size="38" font-weight="700">${escapeXml(options.title)}</text>
    <text x="60" y="110" fill="#9fb2c3" font-family="Arial" font-size="19">PRESERVE_ENGINE_V1 · ${escapeXml(trace.outcome)}</text>
    ${["SOURCE", options.middleLabel, outputLabel].map((label, index) => `<text x="${60 + index * 510}" y="158" fill="#d7e7f3" font-family="Arial" font-size="20" font-weight="700">${escapeXml(label)}</text>`).join("")}
    <rect x="60" y="500" width="720" height="300" rx="18" fill="#10212b"/><rect x="820" y="500" width="720" height="300" rx="18" fill="#10212b"/>
    <text x="90" y="545" fill="#ffbd5d" font-family="Arial" font-size="24" font-weight="700">BEFORE</text>
    ${before.map((line, index) => `<text x="90" y="${590 + index * 38}" fill="#ffffff" font-family="Arial" font-size="20">${escapeXml(line)}</text>`).join("")}
    <text x="850" y="545" fill="#2ae59c" font-family="Arial" font-size="24" font-weight="700">AFTER</text>
    ${after.map((line, index) => `<text x="850" y="${590 + index * 38}" fill="#ffffff" font-family="Arial" font-size="20">${escapeXml(line)}</text>`).join("")}
    <text x="60" y="855" fill="#d7e7f3" font-family="Arial" font-size="20">Pixels modified by Preserve Engine: ${trace.full_image_change_accounting.modified_pixels} (${trace.full_image_change_accounting.modified_pixel_percentage.toFixed(4)}%)</text>
    <text x="60" y="892" fill="#d7e7f3" font-family="Arial" font-size="20">Mapping: ${escapeXml(trace.mapping.model)} · Supporting inliers: ${trace.mapping.supporting_inliers} · Outer ring: ${trace.outer_ring_verification.passed ? "PASS" : "FAIL"}</text>
    <line x1="60" y1="930" x2="1540" y2="930" stroke="#29414f"/>
    <text x="60" y="972" fill="#ffffff" font-family="Arial" font-size="21" font-weight="700">${escapeXml(footer)}</text>
  </svg>`);
  await sharp({ create: { width: 1600, height: 1050, channels: 3, background: "#071219" } })
    .composite([
      { input: svg, top: 0, left: 0 },
      { input: source, top: 180, left: 60 },
      { input: generated, top: 180, left: 570 },
      { input: repaired, top: 180, left: 1080 },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(options.path);
}

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { normalizedPolygonToPixels, polygonBounds } from "./regions.js";
import type { MetricArtifacts, PixelBounds, ProtectedRegion, RawImage } from "./types.js";

export class UnverifiableAlignmentError extends Error {
  readonly code = "UNVERIFIABLE_ALIGNMENT";

  constructor(message: string) {
    super(`UNVERIFIABLE_ALIGNMENT: ${message}`);
    this.name = "UnverifiableAlignmentError";
  }
}

async function decodeNormalized(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Expected normalized RGB image but decoded ${info.channels} channels: ${path}`);
  return { data, width: info.width, height: info.height, channels: 3 };
}

async function resizeRaw(image: RawImage, width: number, height: number): Promise<RawImage> {
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: image.channels },
  }).resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("Aligned image did not remain RGB.");
  return { data, width: info.width, height: info.height, channels: 3 };
}

export interface AlignedImages {
  original: RawImage;
  generated: RawImage;
  alignment: {
    strategy: "identity" | "uniform_scale_lanczos3";
    original_dimensions: { width: number; height: number };
    generated_dimensions_before_alignment: { width: number; height: number };
    compared_dimensions: { width: number; height: number };
  };
}

export async function loadAndAlignImages(originalPath: string, generatedPath: string): Promise<AlignedImages> {
  const [original, generatedBefore] = await Promise.all([decodeNormalized(originalPath), decodeNormalized(generatedPath)]);
  const dimensions = {
    original_dimensions: { width: original.width, height: original.height },
    generated_dimensions_before_alignment: { width: generatedBefore.width, height: generatedBefore.height },
    compared_dimensions: { width: original.width, height: original.height },
  };
  if (original.width === generatedBefore.width && original.height === generatedBefore.height) {
    return { original, generated: generatedBefore, alignment: { strategy: "identity", ...dimensions } };
  }
  const originalRatio = original.width / original.height;
  const generatedRatio = generatedBefore.width / generatedBefore.height;
  const ratioDifference = Math.abs(originalRatio - generatedRatio) / originalRatio;
  const scaleX = original.width / generatedBefore.width;
  const scaleY = original.height / generatedBefore.height;
  if (ratioDifference > 0.001 || Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) > 0.001) {
    throw new UnverifiableAlignmentError(
      `orientation-normalized dimensions ${original.width}x${original.height} and ${generatedBefore.width}x${generatedBefore.height} do not share a uniform scale/aspect ratio.`,
    );
  }
  const generated = await resizeRaw(generatedBefore, original.width, original.height);
  return { original, generated, alignment: { strategy: "uniform_scale_lanczos3", ...dimensions } };
}

export function extractCrop(image: RawImage, bounds: PixelBounds, mask?: Buffer): RawImage {
  const data = Buffer.alloc(bounds.width * bounds.height * 3);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const sourcePixel = (bounds.top + y) * image.width + bounds.left + x;
      if (mask && !mask[sourcePixel]) continue;
      const sourceOffset = sourcePixel * 3;
      const targetOffset = (y * bounds.width + x) * 3;
      image.data.copy(data, targetOffset, sourceOffset, sourceOffset + 3);
    }
  }
  return { data, width: bounds.width, height: bounds.height, channels: 3 };
}

export function extractMaskCrop(mask: Buffer, imageWidth: number, bounds: PixelBounds): Buffer {
  const output = Buffer.alloc(bounds.width * bounds.height);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      output[y * bounds.width + x] = mask[(bounds.top + y) * imageWidth + bounds.left + x]!;
    }
  }
  return output;
}

async function writeRawPng(path: string, image: RawImage): Promise<void> {
  await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(path);
}

function artifactCrop(data: Buffer, image: RawImage, bounds: PixelBounds): RawImage {
  return extractCrop({ ...image, data }, bounds);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

async function writeOverlay(path: string, image: RawImage, region: ProtectedRegion): Promise<void> {
  const points = normalizedPolygonToPixels(region.polygon, image.width, image.height)
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}">`
    + `<polygon points="${points}" fill="rgba(255,215,0,0.20)" stroke="#ff2d00" stroke-width="3"/>`
    + `<text x="8" y="24" fill="#ff2d00" stroke="white" stroke-width="0.5" font-family="sans-serif" font-size="16">${escapeXml(region.label)}</text>`
    + "</svg>",
  );
  await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .composite([{ input: svg, blend: "over" }])
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(path);
}

export async function writeRegionArtifacts(
  outputDirectory: string,
  original: RawImage,
  generated: RawImage,
  region: ProtectedRegion,
  mask: Buffer,
  artifacts: MetricArtifacts,
): Promise<Record<string, string>> {
  await mkdir(outputDirectory, { recursive: false });
  const bounds = polygonBounds(region.polygon, original.width, original.height);
  const paths = {
    original_crop: "original-crop.png",
    generated_crop: "generated-crop.png",
    absolute_difference: "diff.png",
    heatmap: "heatmap.png",
    original_edges: "original-edges.png",
    generated_edges: "generated-edges.png",
    original_overlay: "original-overlay.png",
    generated_overlay: "generated-overlay.png",
  };
  await Promise.all([
    writeRawPng(resolve(outputDirectory, paths.original_crop), extractCrop(original, bounds, mask)),
    writeRawPng(resolve(outputDirectory, paths.generated_crop), extractCrop(generated, bounds, mask)),
    writeRawPng(resolve(outputDirectory, paths.absolute_difference), artifactCrop(artifacts.absoluteDifference, original, bounds)),
    writeRawPng(resolve(outputDirectory, paths.heatmap), artifactCrop(artifacts.heatmap, original, bounds)),
    writeRawPng(resolve(outputDirectory, paths.original_edges), artifactCrop(artifacts.originalEdges, original, bounds)),
    writeRawPng(resolve(outputDirectory, paths.generated_edges), artifactCrop(artifacts.generatedEdges, original, bounds)),
    writeOverlay(resolve(outputDirectory, paths.original_overlay), original, region),
    writeOverlay(resolve(outputDirectory, paths.generated_overlay), generated, region),
  ]);
  return paths;
}

export async function writeImagePng(path: string, image: RawImage): Promise<void> {
  await writeRawPng(path, image);
}

export function regionCrop(image: RawImage, region: ProtectedRegion, mask: Buffer): RawImage {
  return extractCrop(image, polygonBounds(region.polygon, image.width, image.height), mask);
}

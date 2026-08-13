import type { MeasurementResult, RawImage } from "./types.js";

function assertComparable(original: RawImage, generated: RawImage, mask: Buffer): void {
  if (original.width !== generated.width || original.height !== generated.height) {
    throw new Error("Metric inputs must have identical dimensions after alignment.");
  }
  if (mask.length !== original.width * original.height) throw new Error("Region mask dimensions do not match the images.");
  if (!mask.includes(1)) throw new Error("Region mask is empty.");
}

export function grayscale(image: RawImage): Float64Array {
  const output = new Float64Array(image.width * image.height);
  for (let pixel = 0; pixel < output.length; pixel += 1) {
    const offset = pixel * 3;
    output[pixel] = 0.2126 * image.data[offset]! + 0.7152 * image.data[offset + 1]! + 0.0722 * image.data[offset + 2]!;
  }
  return output;
}

export function sobelMagnitude(gray: Float64Array, width: number, height: number): Float64Array {
  const output = new Float64Array(width * height);
  const maxMagnitude = 4 * 255 * Math.SQRT2;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const topLeft = gray[index - width - 1]!;
      const top = gray[index - width]!;
      const topRight = gray[index - width + 1]!;
      const left = gray[index - 1]!;
      const right = gray[index + 1]!;
      const bottomLeft = gray[index + width - 1]!;
      const bottom = gray[index + width]!;
      const bottomRight = gray[index + width + 1]!;
      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      output[index] = Math.min(1, Math.hypot(gx, gy) / maxMagnitude);
    }
  }
  return output;
}

export function globalGrayscaleSsim(
  originalGray: Float64Array,
  generatedGray: Float64Array,
  mask: Buffer,
): number {
  let count = 0;
  let originalMean = 0;
  let generatedMean = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    count += 1;
    originalMean += originalGray[index]!;
    generatedMean += generatedGray[index]!;
  }
  if (count === 0) throw new Error("Cannot compute SSIM for an empty mask.");
  originalMean /= count;
  generatedMean /= count;
  let originalVariance = 0;
  let generatedVariance = 0;
  let covariance = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const originalDelta = originalGray[index]! - originalMean;
    const generatedDelta = generatedGray[index]! - generatedMean;
    originalVariance += originalDelta * originalDelta;
    generatedVariance += generatedDelta * generatedDelta;
    covariance += originalDelta * generatedDelta;
  }
  originalVariance /= count;
  generatedVariance /= count;
  covariance /= count;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const numerator = (2 * originalMean * generatedMean + c1) * (2 * covariance + c2);
  const denominator = (originalMean ** 2 + generatedMean ** 2 + c1) * (originalVariance + generatedVariance + c2);
  return Math.max(-1, Math.min(1, numerator / denominator));
}

function heatColor(normalizedDifference: number): [number, number, number] {
  const value = Math.max(0, Math.min(1, normalizedDifference));
  return [
    Math.round(255 * value),
    Math.round(255 * (1 - Math.abs(2 * value - 1))),
    Math.round(255 * (1 - value)),
  ];
}

export function measureRegion(
  original: RawImage,
  generated: RawImage,
  mask: Buffer,
  pixelTolerance8Bit: number,
  sobelThresholdNormalized: number,
): MeasurementResult {
  assertComparable(original, generated, mask);
  if (!Number.isInteger(pixelTolerance8Bit) || pixelTolerance8Bit < 0 || pixelTolerance8Bit > 255) {
    throw new Error("Pixel tolerance must be an integer from 0 through 255.");
  }
  if (!Number.isFinite(sobelThresholdNormalized) || sobelThresholdNormalized < 0 || sobelThresholdNormalized > 1) {
    throw new Error("Sobel threshold must be from 0 through 1.");
  }

  const absoluteDifference = Buffer.alloc(original.data.length);
  const heatmap = Buffer.alloc(original.data.length);
  let absoluteSum = 0;
  let changedPixels = 0;
  let totalPixels = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    totalPixels += 1;
    const offset = pixel * 3;
    let maximumDifference = 0;
    let channelSum = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(original.data[offset + channel]! - generated.data[offset + channel]!);
      absoluteDifference[offset + channel] = difference;
      absoluteSum += difference;
      channelSum += difference;
      maximumDifference = Math.max(maximumDifference, difference);
    }
    if (maximumDifference > pixelTolerance8Bit) changedPixels += 1;
    const [red, green, blue] = heatColor(channelSum / (3 * 255));
    heatmap[offset] = red;
    heatmap[offset + 1] = green;
    heatmap[offset + 2] = blue;
  }

  const originalGray = grayscale(original);
  const generatedGray = grayscale(generated);
  const ssim = globalGrayscaleSsim(originalGray, generatedGray, mask);
  const originalSobel = sobelMagnitude(originalGray, original.width, original.height);
  const generatedSobel = sobelMagnitude(generatedGray, generated.width, generated.height);
  const originalEdges = Buffer.alloc(original.data.length);
  const generatedEdges = Buffer.alloc(generated.data.length);
  let originalEdgePixels = 0;
  let generatedEdgePixels = 0;
  let mismatchedEdgePixels = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const originalEdge = originalSobel[pixel]! >= sobelThresholdNormalized;
    const generatedEdge = generatedSobel[pixel]! >= sobelThresholdNormalized;
    if (originalEdge) originalEdgePixels += 1;
    if (generatedEdge) generatedEdgePixels += 1;
    if (originalEdge !== generatedEdge) mismatchedEdgePixels += 1;
    const offset = pixel * 3;
    originalEdges.fill(originalEdge ? 255 : 0, offset, offset + 3);
    generatedEdges.fill(generatedEdge ? 255 : 0, offset, offset + 3);
  }

  return {
    measurements: {
      mean_absolute_difference: {
        normalized: absoluteSum / (totalPixels * 3 * 255),
        raw_absolute_channel_sum: absoluteSum,
        compared_channels: totalPixels * 3,
        range: "0..1",
      },
      changed_pixel_ratio: {
        tolerance_8bit: pixelTolerance8Bit,
        changed_pixels: changedPixels,
        total_region_pixels: totalPixels,
        ratio: changedPixels / totalPixels,
        per_pixel_rule: "maximum RGB channel difference exceeds tolerance",
      },
      ssim: {
        value: ssim,
        range: "-1..1",
        implementation: "global grayscale SSIM formula",
        k1: 0.01,
        k2: 0.03,
        dynamic_range: 255,
      },
      edge_difference: {
        sobel_threshold_normalized: sobelThresholdNormalized,
        original_edge_pixels: originalEdgePixels,
        generated_edge_pixels: generatedEdgePixels,
        mismatched_edge_pixels: mismatchedEdgePixels,
        total_region_pixels: totalPixels,
        ratio: mismatchedEdgePixels / totalPixels,
        range: "0..1",
      },
    },
    artifacts: { absoluteDifference, heatmap, originalEdges, generatedEdges },
  };
}

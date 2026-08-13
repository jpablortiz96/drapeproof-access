import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import sharp from "sharp";
import { MAX_FILE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, MIN_IMAGE_HEIGHT, MIN_IMAGE_WIDTH } from "../../config.js";
import type { SessionAsset } from "./types.js";

export class ProductUploadError extends Error {
  constructor(public readonly code: "UNSUPPORTED_FILE" | "MIME_MISMATCH" | "FILE_TOO_LARGE" | "IMAGE_TOO_SMALL" | "IMAGE_TOO_LARGE" | "IMAGE_UNREADABLE", message: string) {
    super(message);
    this.name = "ProductUploadError";
  }
}

export async function normalizeImageUpload(options: {
  kind: SessionAsset["kind"];
  originalName: string;
  mediaType: string;
  bytes: Uint8Array;
}): Promise<{ asset: SessionAsset; bytes: Buffer }> {
  const declaredType = options.mediaType.toLowerCase().split(";", 1)[0]!;
  const extension = extname(options.originalName).toLowerCase();
  const allowedExtensions: Record<string, string[]> = {
    "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/webp": [".webp"],
  };
  if (!Object.hasOwn(allowedExtensions, declaredType) || !allowedExtensions[declaredType]!.includes(extension)) {
    throw new ProductUploadError("UNSUPPORTED_FILE", "Choose a JPG, PNG, or WebP image.");
  }
  if (options.bytes.byteLength <= 0 || options.bytes.byteLength >= MAX_FILE_BYTES) {
    throw new ProductUploadError("FILE_TOO_LARGE", "Choose an image smaller than 4 MB.");
  }
  const signature = options.bytes.subarray(0, 12);
  const detectedType = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff ? "image/jpeg"
    : signature.length >= 8 && [...signature.subarray(0, 8)].join(",") === "137,80,78,71,13,10,26,10" ? "image/png"
      : signature.length >= 12 && Buffer.from(signature.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(signature.subarray(8, 12)).toString("ascii") === "WEBP" ? "image/webp"
        : null;
  if (!detectedType || detectedType !== declaredType) {
    throw new ProductUploadError("MIME_MISMATCH", "The file contents do not match its image type.");
  }
  let pipeline = sharp(options.bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" }).rotate();
  let metadata;
  try { metadata = await pipeline.metadata(); }
  catch { throw new ProductUploadError("IMAGE_UNREADABLE", "This image could not be opened. Try another JPG, PNG, or WebP file."); }
  const decodedType = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "png" ? "image/png" : metadata.format === "webp" ? "image/webp" : null;
  if (decodedType !== declaredType) throw new ProductUploadError("MIME_MISMATCH", "The file contents do not match its image type.");
  if (!metadata.width || !metadata.height) throw new ProductUploadError("IMAGE_UNREADABLE", "This image has no readable dimensions.");
  const width = metadata.autoOrient.width;
  const height = metadata.autoOrient.height;
  if (width * height > MAX_IMAGE_PIXELS) throw new ProductUploadError("IMAGE_TOO_LARGE", "This image has too many pixels. Choose a smaller image.");
  if (Math.max(width, height) < MIN_IMAGE_WIDTH || Math.min(width, height) < MIN_IMAGE_HEIGHT) {
    throw new ProductUploadError("IMAGE_TOO_SMALL", `Choose an image at least ${MIN_IMAGE_WIDTH} × ${MIN_IMAGE_HEIGHT} pixels.`);
  }
  if (Math.max(width, height) > MAX_IMAGE_SIDE) {
    pipeline = pipeline.resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true });
  }
  const outputPng = declaredType !== "image/jpeg";
  const bytes = outputPng ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : await pipeline.jpeg({ quality: 94 }).toBuffer();
  const outputMetadata = await sharp(bytes).metadata();
  const canonicalExtension = outputPng ? "png" : "jpg";
  return {
    bytes,
    asset: {
      kind: options.kind,
      filename: options.kind === "result" ? `result.${canonicalExtension}` : `${options.kind}-${randomUUID()}.${canonicalExtension}`,
      mediaType: outputPng ? "image/png" : "image/jpeg",
      width: outputMetadata.width!, height: outputMetadata.height!, size: bytes.byteLength,
    },
  };
}

import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_SIDE,
  MIN_IMAGE_HEIGHT,
  MIN_IMAGE_WIDTH,
} from "./config.js";

export type FixtureKind = "person" | "garment";

export interface ValidatedFixture {
  path: string;
  extension: ".jpg" | ".jpeg" | ".png";
  contentType: "image/jpg" | "image/png";
  size: number;
  width: number;
  height: number;
}

export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(`BLOCKED_MANUAL_INPUT: ${message}`);
    this.name = "FixtureValidationError";
  }
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

export function readImageDimensions(bytes: Buffer, extension: string): { width: number; height: number } {
  const dimensions = extension === ".png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new FixtureValidationError("The image could not be decoded as the declared JPG/PNG type.");
  }
  return dimensions;
}

export async function validateFixture(path: string, kind: FixtureKind): Promise<ValidatedFixture> {
  const absolutePath = resolve(path);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    throw new FixtureValidationError(`Missing ${kind} fixture: ${absolutePath}`);
  }
  if (!fileStat.isFile()) throw new FixtureValidationError(`${kind} fixture is not a file: ${absolutePath}`);

  const extension = extname(absolutePath).toLowerCase();
  if (extension !== ".jpg" && extension !== ".jpeg" && extension !== ".png") {
    throw new FixtureValidationError(`${kind} fixture must be JPG or PNG: ${absolutePath}`);
  }
  if (fileStat.size <= 0 || fileStat.size >= MAX_FILE_BYTES) {
    throw new FixtureValidationError(`${kind} fixture must be non-empty and smaller than 10 MB: ${absolutePath}`);
  }

  const bytes = await readFile(absolutePath);
  const { width, height } = readImageDimensions(bytes, extension);
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (longSide < MIN_IMAGE_WIDTH || shortSide < MIN_IMAGE_HEIGHT) {
    throw new FixtureValidationError(
      `${kind} fixture must be at least ${MIN_IMAGE_WIDTH}x${MIN_IMAGE_HEIGHT} px: ${absolutePath} is ${width}x${height}.`,
    );
  }
  if (longSide > MAX_IMAGE_SIDE) {
    throw new FixtureValidationError(`${kind} fixture long side must not exceed ${MAX_IMAGE_SIDE} px: ${absolutePath}`);
  }

  return {
    path: absolutePath,
    extension,
    contentType: extension === ".png" ? "image/png" : "image/jpg",
    size: fileStat.size,
    width,
    height,
  };
}

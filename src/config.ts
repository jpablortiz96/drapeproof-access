import dotenv from "dotenv";

export const YOUCAM_BASE_URL = "https://yce-api-01.makeupar.com";
export const YOUCAM_FILE_PATH = "/s2s/v2.0/file";
export const YOUCAM_TASK_PATH = "/s2s/v2.0/task/cloth-v4";
export const YOUCAM_API_PRODUCT = "AI Clothes Virtual Try-On";
export const YOUCAM_API_VERSION = "Clothes V4.0 (API path v2.0)";
export const YOUCAM_SKIN_TASK_PATH = "/s2s/v2.1/task/skin-analysis";
export const YOUCAM_SKIN_API_VERSION = "Skin Analysis V2.1";
export const YOUCAM_FEATURE_COST_PATH = "/s2s/v2.0/credit/feature-cost";

export const MAX_FILE_BYTES = 4_000_000;
export const MIN_IMAGE_WIDTH = 512;
export const MIN_IMAGE_HEIGHT = 384;
export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;

export interface AppConfig {
  apiKey: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  maxHttpRetries: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  dotenv.config({ quiet: true });
  const apiKey = env.YOUCAM_API_KEY?.trim() ?? process.env.YOUCAM_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      "BLOCKED_MANUAL_INPUT: Set YOUCAM_API_KEY in a local .env file (copy .env.example), then rerun the probe.",
    );
  }

  return {
    apiKey,
    pollIntervalMs: positiveInteger(env.YOUCAM_POLL_INTERVAL_MS, 2_000, "YOUCAM_POLL_INTERVAL_MS"),
    pollTimeoutMs: positiveInteger(env.YOUCAM_POLL_TIMEOUT_MS, 180_000, "YOUCAM_POLL_TIMEOUT_MS"),
    maxHttpRetries: positiveInteger(env.YOUCAM_MAX_HTTP_RETRIES, 3, "YOUCAM_MAX_HTTP_RETRIES"),
  };
}

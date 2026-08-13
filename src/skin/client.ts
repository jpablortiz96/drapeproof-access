import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import {
  YOUCAM_BASE_URL,
  YOUCAM_FEATURE_COST_PATH,
  YOUCAM_FILE_PATH,
  YOUCAM_SKIN_TASK_PATH,
} from "../config.js";
import type { ValidatedFixture } from "../validation.js";
import { ResponseShapeError, YouCamHttpError } from "../youcam/errors.js";
import { parseCreatedTask, parseInitializedFile } from "../youcam/client.js";
import type { CreatedTask, InitializedFile } from "../youcam/types.js";

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

export const SKIN_CONCERNS = ["texture", "pore", "redness", "radiance"] as const;
export type SkinConcern = typeof SKIN_CONCERNS[number];

export interface SkinAnalysisOutput {
  type: string;
  region?: string;
  raw_score?: number;
  ui_score?: number;
  score?: number;
  mask_urls?: string[];
  [key: string]: unknown;
}

export interface SkinTaskStatus {
  taskStatus: "running" | "success" | "error";
  error?: unknown;
  errorMessage?: string;
  results?: { output: SkinAnalysisOutput[] };
  raw: unknown;
}

export interface FeatureCostSku {
  description: string;
  amount: number;
  unit: string;
  proc_unit: number;
  run_task_url: string;
  [key: string]: unknown;
}

export interface FeatureCostPage {
  nextToken: string | null;
  skus: FeatureCostSku[];
  raw: unknown;
}

export interface SkinAnalysisClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  maxRetries?: number;
  baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return isRecord(item) ? item : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function bodyStatus(payload: unknown): number | undefined {
  return numberAt(payload, "status");
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { non_json_response: text };
  }
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(8_000, 500 * 2 ** attempt);
}

export function parseFeatureCostPage(payload: unknown): Omit<FeatureCostPage, "raw"> {
  const result = recordAt(payload, "result");
  if (!result || !Array.isArray(result.skus)) {
    throw new ResponseShapeError("Feature-cost response is missing result.skus.");
  }
  const skus = result.skus.map((item, index): FeatureCostSku => {
    if (!isRecord(item)) throw new ResponseShapeError(`Feature-cost SKU ${index} is not an object.`);
    const description = stringAt(item, "description");
    const amount = numberAt(item, "amount");
    const unit = stringAt(item, "unit");
    const procUnit = numberAt(item, "proc_unit");
    const runTaskUrl = stringAt(item, "run_task_url");
    if (!description || amount === undefined || !unit || procUnit === undefined || !runTaskUrl) {
      throw new ResponseShapeError(`Feature-cost SKU ${index} is missing a documented field.`);
    }
    return { ...item, description, amount, unit, proc_unit: procUnit, run_task_url: runTaskUrl };
  });
  const next = result.next_token;
  if (next !== null && next !== undefined && typeof next !== "string") {
    throw new ResponseShapeError("Feature-cost result.next_token is not a string or null.");
  }
  return { nextToken: typeof next === "string" && next ? next : null, skus };
}

export function parseSkinTaskStatus(payload: unknown): SkinTaskStatus {
  const data = recordAt(payload, "data");
  const taskStatus = stringAt(data, "task_status");
  if (!data || (taskStatus !== "running" && taskStatus !== "success" && taskStatus !== "error")) {
    throw new ResponseShapeError("Skin Analysis status response has an undocumented or missing data.task_status.");
  }
  const output: SkinTaskStatus = { taskStatus, raw: payload };
  if ("error" in data) output.error = data.error;
  const errorMessage = stringAt(data, "error_message");
  if (errorMessage) output.errorMessage = errorMessage;
  const results = recordAt(data, "results");
  if (results) {
    if (!Array.isArray(results.output)) throw new ResponseShapeError("Skin Analysis JSON results are missing output[].");
    const parsedOutput: SkinAnalysisOutput[] = results.output.map((item, index) => {
      if (!isRecord(item) || !stringAt(item, "type")) {
        throw new ResponseShapeError(`Skin Analysis output ${index} is missing type.`);
      }
      return item as SkinAnalysisOutput;
    });
    output.results = { output: parsedOutput };
  }
  if (taskStatus === "success" && !output.results) {
    throw new ResponseShapeError("Successful Skin Analysis JSON task did not include data.results.output.");
  }
  return output;
}

export class SkinAnalysisClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(options: SkinAnalysisClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxRetries = options.maxRetries ?? 3;
    this.baseUrl = options.baseUrl ?? YOUCAM_BASE_URL;
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      let payload: unknown;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
        payload = await responsePayload(response);
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(retryDelay(undefined, attempt));
          continue;
        }
        throw new YouCamHttpError(`YouCam request failed: ${String(error)}`, 0, null, true);
      }
      const providerStatus = bodyStatus(payload);
      const failed = !response.ok || (providerStatus !== undefined && providerStatus >= 400);
      if (!failed) return payload;
      const retryable = response.status === 429 || response.status >= 500 || providerStatus === 429 || (providerStatus ?? 0) >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(`YouCam request failed with HTTP ${response.status}.`, response.status, payload, retryable);
    }
  }

  async getFeatureCosts(startingToken?: string): Promise<FeatureCostPage> {
    const query = new URLSearchParams({ page_size: "20" });
    if (startingToken) query.set("starting_token", startingToken);
    const raw = await this.requestJson(`${YOUCAM_FEATURE_COST_PATH}?${query.toString()}`, { method: "GET" });
    return { ...parseFeatureCostPage(raw), raw };
  }

  async initializeFile(file: ValidatedFixture): Promise<InitializedFile> {
    const raw = await this.requestJson(YOUCAM_FILE_PATH, {
      method: "POST",
      body: JSON.stringify({ files: [{ content_type: file.contentType, file_name: basename(file.path), file_size: file.size }] }),
    });
    return { ...parseInitializedFile(raw), raw };
  }

  async uploadFile(file: ValidatedFixture, initialized: InitializedFile): Promise<void> {
    const bytes = await readFile(file.path);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchImpl(initialized.request.url, {
          method: initialized.request.method,
          headers: initialized.request.headers,
          body: bytes as unknown as BodyInit,
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(retryDelay(undefined, attempt));
          continue;
        }
        throw new YouCamHttpError(`Skin input upload failed: ${String(error)}`, 0, null, true);
      }
      if (response.ok) return;
      const payload = await responsePayload(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(`Skin input upload failed with HTTP ${response.status}.`, response.status, payload, retryable);
    }
  }

  async createTask(srcFileId: string): Promise<CreatedTask> {
    const raw = await this.requestJson(YOUCAM_SKIN_TASK_PATH, {
      method: "POST",
      body: JSON.stringify({
        src_file_id: srcFileId,
        dst_actions: SKIN_CONCERNS,
        miniserver_args: { enable_mask_overlay: false },
        format: "json",
        pf_camera_kit: false,
      }),
    });
    return { ...parseCreatedTask(raw), raw };
  }

  async getTaskStatus(taskId: string): Promise<SkinTaskStatus> {
    const raw = await this.requestJson(`${YOUCAM_SKIN_TASK_PATH}/${encodeURIComponent(taskId)}`, { method: "GET" });
    return parseSkinTaskStatus(raw);
  }

  async download(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchImpl(url);
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(retryDelay(undefined, attempt));
          continue;
        }
        throw new YouCamHttpError(`Skin result download failed: ${String(error)}`, 0, null, true);
      }
      if (response.ok) return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
      const payload = await responsePayload(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(`Skin result download failed with HTTP ${response.status}.`, response.status, payload, retryable);
    }
  }
}

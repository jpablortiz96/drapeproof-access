import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { YOUCAM_BASE_URL, YOUCAM_FILE_PATH } from "../config.js";
import type { ValidatedFixture } from "../validation.js";
import { parseCreatedTask, parseInitializedFile, parseTaskStatus } from "../youcam/client.js";
import { ResponseShapeError, YouCamHttpError } from "../youcam/errors.js";
import type { CreatedTask, InitializedFile, TaskStatusData } from "../youcam/types.js";

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

export const YOUCAM_BAG_TASK_PATH = "/s2s/v2.0/task/bag";
export const YOUCAM_BAG_API_VERSION = "Bag Virtual Try-On V2.0";
export const YOUCAM_FEATURE_COST_PATH = "/s2s/v2.0/credit/feature-cost";
export const BAG_GENDER = "male" as const;

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

export interface BagClientOptions {
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

export function buildBagTaskBody(srcFileId: string, refFileId: string): {
  src_file_id: string;
  ref_file_id: string;
  gender: typeof BAG_GENDER;
} {
  if (!srcFileId || !refFileId) throw new Error("Bag task requires non-empty source and reference file IDs.");
  return { src_file_id: srcFileId, ref_file_id: refFileId, gender: BAG_GENDER };
}

export function parseFeatureCostPage(payload: unknown): Omit<FeatureCostPage, "raw"> {
  const result = recordAt(payload, "result");
  if (!result || !Array.isArray(result.skus)) throw new ResponseShapeError("Feature-cost response is missing result.skus.");
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
  if (next !== null && next !== undefined && typeof next !== "string") throw new ResponseShapeError("Feature-cost next_token is invalid.");
  return { nextToken: typeof next === "string" && next ? next : null, skus };
}

export function selectBagCostSku(pages: readonly FeatureCostPage[]): FeatureCostSku {
  const matches = pages.flatMap((page) => page.skus).filter((sku) =>
    /\/s2s\/v2\.0\/task\/bag$/.test(sku.run_task_url)
    && /^AI Bag Virtual Try-On V2\.0$/i.test(sku.description),
  );
  if (matches.length !== 1) throw new Error(`Expected one current Bag V2.0 feature-cost SKU, found ${matches.length}.`);
  return matches[0]!;
}

export function expectedBagUnits(sku: FeatureCostSku): number {
  if (!Number.isFinite(sku.amount) || sku.amount < 0 || !Number.isInteger(sku.proc_unit) || sku.proc_unit <= 0) {
    throw new Error("Bag feature-cost SKU has invalid amount/proc_unit.");
  }
  return Math.ceil(1 / sku.proc_unit) * sku.amount;
}

export class BagClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(options: BagClientOptions) {
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
        throw new YouCamHttpError(`Bag API request failed: ${String(error)}`, 0, null, true);
      }
      const providerStatus = bodyStatus(payload);
      const failed = !response.ok || (providerStatus !== undefined && providerStatus >= 400);
      if (!failed) return payload;
      const retryable = response.status === 429 || response.status >= 500 || providerStatus === 429 || (providerStatus ?? 0) >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(`Bag API request failed with HTTP ${response.status}.`, response.status, payload, retryable);
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
        throw new YouCamHttpError(`Bag file upload failed: ${String(error)}`, 0, null, true);
      }
      if (response.ok) return;
      const payload = await responsePayload(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(`Bag file upload failed with HTTP ${response.status}.`, response.status, payload, retryable);
    }
  }

  async createTask(srcFileId: string, refFileId: string): Promise<CreatedTask> {
    const raw = await this.requestJson(YOUCAM_BAG_TASK_PATH, {
      method: "POST",
      body: JSON.stringify(buildBagTaskBody(srcFileId, refFileId)),
    });
    return { ...parseCreatedTask(raw), raw };
  }

  async getTaskStatus(taskId: string): Promise<TaskStatusData> {
    const raw = await this.requestJson(`${YOUCAM_BAG_TASK_PATH}/${encodeURIComponent(taskId)}`, { method: "GET" });
    return parseTaskStatus(raw);
  }

  async downloadResult(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchImpl(url);
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(retryDelay(undefined, attempt));
          continue;
        }
        throw new YouCamHttpError(`Bag result download failed: ${String(error)}`, 0, null, true);
      }
      if (response.ok) return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
      const payload = await responsePayload(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(`Bag result download failed with HTTP ${response.status}.`, response.status, payload, retryable);
    }
  }
}

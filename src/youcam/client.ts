import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { YOUCAM_BASE_URL, YOUCAM_FILE_PATH, YOUCAM_TASK_PATH } from "../config.js";
import type { ValidatedFixture } from "../validation.js";
import { ResponseShapeError, YouCamHttpError } from "./errors.js";
import type { CreatedTask, GarmentCategory, InitializedFile, TaskStatusData } from "./types.js";

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

export interface YouCamClientOptions {
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

export function parseInitializedFile(payload: unknown): Omit<InitializedFile, "raw"> {
  const data = recordAt(payload, "data");
  const files = data?.files;
  const file = Array.isArray(files) ? files[0] : undefined;
  if (!isRecord(file)) throw new ResponseShapeError("YouCam File API response is missing data.files[0].");
  const fileId = stringAt(file, "file_id");
  const fileName = stringAt(file, "file_name");
  const contentType = stringAt(file, "content_type");
  const requests = file.requests;
  const request = Array.isArray(requests) ? requests[0] : undefined;
  if (!fileId || !fileName || !contentType || !isRecord(request)) {
    throw new ResponseShapeError("YouCam File API response is missing a documented file or upload-request field.");
  }
  const method = stringAt(request, "method");
  const url = stringAt(request, "url");
  const rawHeaders = request.headers;
  if (!method || !url || !isRecord(rawHeaders)) {
    throw new ResponseShapeError("YouCam File API response is missing requests[0].method/url/headers.");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value !== "string") throw new ResponseShapeError("YouCam upload instruction contains a non-string header.");
    headers[key] = value;
  }
  return { contentType, fileName, fileId, request: { method, url, headers } };
}

export function parseCreatedTask(payload: unknown): Omit<CreatedTask, "raw"> {
  const taskId = stringAt(recordAt(payload, "data"), "task_id");
  if (!taskId) throw new ResponseShapeError("YouCam task response is missing data.task_id.");
  return { taskId };
}

export function parseTaskStatus(payload: unknown): TaskStatusData {
  const data = recordAt(payload, "data");
  const taskStatus = stringAt(data, "task_status");
  if (!data || !taskStatus) throw new ResponseShapeError("YouCam status response is missing data.task_status.");
  const results = recordAt(data, "results");
  const resultUrl = stringAt(results, "url");
  const errorMessage = stringAt(data, "error_message");
  const output: TaskStatusData = { taskStatus, raw: payload };
  if ("error" in data) output.error = data.error;
  if (errorMessage) output.errorMessage = errorMessage;
  if (resultUrl) output.resultUrl = resultUrl;
  return output;
}

function bodyStatus(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  return typeof payload.status === "number" ? payload.status : undefined;
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

export class YouCamClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(options: YouCamClientOptions) {
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
      const status = response.status;
      const failed = !response.ok || (providerStatus !== undefined && providerStatus >= 400);
      if (!failed) return payload;

      const retryable = status === 429 || status >= 500 || providerStatus === 429 || (providerStatus ?? 0) >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(`YouCam request failed with HTTP ${status}.`, status, payload, retryable);
    }
  }

  async initializeFile(file: ValidatedFixture): Promise<InitializedFile> {
    const raw = await this.requestJson(YOUCAM_FILE_PATH, {
      method: "POST",
      body: JSON.stringify({
        files: [{ content_type: file.contentType, file_name: basename(file.path), file_size: file.size }],
      }),
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
        throw new YouCamHttpError(`YouCam presigned upload failed: ${String(error)}`, 0, null, true);
      }
      if (response.ok) return;
      const payload = await responsePayload(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(
        `YouCam presigned upload failed with HTTP ${response.status}.`,
        response.status,
        payload,
        retryable,
      );
    }
  }

  async createTask(srcFileId: string, refFileId: string, garmentCategory: GarmentCategory): Promise<CreatedTask> {
    const raw = await this.requestJson(YOUCAM_TASK_PATH, {
      method: "POST",
      body: JSON.stringify({
        src_file_id: srcFileId,
        ref_file_id: refFileId,
        garment_category: garmentCategory,
      }),
    });
    return { ...parseCreatedTask(raw), raw };
  }

  async getTaskStatus(taskId: string): Promise<TaskStatusData> {
    const raw = await this.requestJson(`${YOUCAM_TASK_PATH}/${encodeURIComponent(taskId)}`, { method: "GET" });
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
        throw new YouCamHttpError(`Result download failed: ${String(error)}`, 0, null, true);
      }
      if (response.ok) {
        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get("content-type"),
        };
      }
      const payload = await responsePayload(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new YouCamHttpError(
        `Result download failed with HTTP ${response.status}.`,
        response.status,
        payload,
        retryable,
      );
    }
  }
}

import dotenv from "dotenv";
import type { ValidatedFixture } from "../../validation.js";
import { YouCamClient } from "../../youcam/client.js";
import { YouCamHttpError } from "../../youcam/errors.js";
import { BagClient } from "../../bag/client.js";
import { repositoryRoot } from "./paths.js";
import type { SessionAsset, TryOnCategory } from "./types.js";

export interface GenerationStart {
  taskId: string;
  product: "AI Clothes Virtual Try-On" | "AI Bag Virtual Try-On";
  version: "Clothes V4.0" | "Bag Virtual Try-On V2.0";
}

export interface GenerationPoll {
  state: "RUNNING" | "SUCCESS" | "FAILED";
  result?: { bytes: Buffer; mediaType: string | null };
  error?: string;
}

export interface LiveGenerationProvider {
  start(category: TryOnCategory, source: ValidatedFixture, product: ValidatedFixture): Promise<GenerationStart>;
  poll(category: TryOnCategory, taskId: string): Promise<GenerationPoll>;
}

export class ProviderSubmissionError extends Error {
  constructor(message: string, readonly definitePreAcceptance: boolean) {
    super(message);
    this.name = "ProviderSubmissionError";
  }
}

export function fixtureFromAsset(path: string, asset: SessionAsset): ValidatedFixture {
  return {
    path,
    extension: asset.mediaType === "image/png" ? ".png" : ".jpg",
    contentType: asset.mediaType === "image/png" ? "image/png" : "image/jpg",
    size: asset.size,
    width: asset.width,
    height: asset.height,
  };
}

export function loadServerApiKey(): string {
  dotenv.config({ path: `${repositoryRoot()}/.env`, quiet: true });
  const value = process.env.YOUCAM_API_KEY?.trim();
  if (!value) throw new Error("Live generation is not configured yet. Add the server API key and try again.");
  return value;
}

function providerErrorMessage(message: string | undefined): string {
  if (!message) return "The preview could not be created. Try again with another photo or product image.";
  return message.length > 180 ? "The preview could not be created. Try again in a moment." : message;
}

export class YouCamLiveGenerationProvider implements LiveGenerationProvider {
  async start(category: TryOnCategory, source: ValidatedFixture, product: ValidatedFixture): Promise<GenerationStart> {
    let semanticSubmissionStarted = false;
    try {
      const key = loadServerApiKey();
      if (category === "CLOTHING") {
        const client = new YouCamClient({ apiKey: key });
        const [sourceUpload, productUpload] = await Promise.all([client.initializeFile(source), client.initializeFile(product)]);
        await Promise.all([client.uploadFile(source, sourceUpload), client.uploadFile(product, productUpload)]);
        semanticSubmissionStarted = true;
        const task = await client.createTask(sourceUpload.fileId, productUpload.fileId, "auto");
        return { taskId: task.taskId, product: "AI Clothes Virtual Try-On", version: "Clothes V4.0" };
      }
      const client = new BagClient({ apiKey: key });
      const [sourceUpload, productUpload] = await Promise.all([client.initializeFile(source), client.initializeFile(product)]);
      await Promise.all([client.uploadFile(source, sourceUpload), client.uploadFile(product, productUpload)]);
      semanticSubmissionStarted = true;
      const task = await client.createTask(sourceUpload.fileId, productUpload.fileId);
      return { taskId: task.taskId, product: "AI Bag Virtual Try-On", version: "Bag Virtual Try-On V2.0" };
    } catch (error) {
      const definiteProviderRejection = semanticSubmissionStarted && error instanceof YouCamHttpError
        && error.status >= 400 && error.status < 500 && error.status !== 429;
      const definitePreAcceptance = !semanticSubmissionStarted || definiteProviderRejection;
      throw new ProviderSubmissionError(providerErrorMessage(error instanceof Error ? error.message : undefined), definitePreAcceptance);
    }
  }

  async poll(category: TryOnCategory, taskId: string): Promise<GenerationPoll> {
    const key = loadServerApiKey();
    const client = category === "CLOTHING" ? new YouCamClient({ apiKey: key }) : new BagClient({ apiKey: key });
    const status = await client.getTaskStatus(taskId);
    if (status.taskStatus === "running") return { state: "RUNNING" };
    if (status.taskStatus !== "success" || !status.resultUrl) {
      return { state: "FAILED", error: providerErrorMessage(status.errorMessage) };
    }
    const result = await client.downloadResult(status.resultUrl);
    return { state: "SUCCESS", result: { bytes: result.bytes, mediaType: result.contentType } };
  }
}

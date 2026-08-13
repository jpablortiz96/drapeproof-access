import { describe, expect, it, vi } from "vitest";
import {
  YouCamClient,
  parseCreatedTask,
  parseInitializedFile,
  parseTaskStatus,
} from "../src/youcam/client.js";
import { ResponseShapeError, YouCamHttpError } from "../src/youcam/errors.js";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("YouCam response parsing", () => {
  it("parses the documented File API envelope", () => {
    const raw = {
      status: 200,
      data: {
        files: [{
          content_type: "image/png",
          file_name: "person.png",
          file_id: "file-1",
          requests: [{ method: "PUT", url: "https://upload.example/signed", headers: { "Content-Type": "image/png" } }],
        }],
      },
    };
    expect(parseInitializedFile(raw)).toMatchObject({ fileId: "file-1", request: { method: "PUT" } });
  });

  it("parses task creation and status envelopes", () => {
    expect(parseCreatedTask({ status: 200, data: { task_id: "task-1" } })).toEqual({ taskId: "task-1" });
    expect(
      parseTaskStatus({ status: 200, data: { task_status: "success", error: null, results: { url: "https://result" } } }),
    ).toMatchObject({ taskStatus: "success", resultUrl: "https://result", error: null });
  });

  it("rejects a response missing documented fields", () => {
    expect(() => parseCreatedTask({ status: 200, data: {} })).toThrow(ResponseShapeError);
  });
});

describe("YouCam HTTP retry behavior", () => {
  it("retries HTTP 429 and honors Retry-After", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 429, error: "Too many requests" }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse({ status: 200, data: { task_id: "task-1" } }));
    const sleep = vi.fn(async () => undefined);
    const client = new YouCamClient({ apiKey: "secret", fetchImpl, sleep, maxRetries: 1 });
    await expect(client.createTask("src", "ref", "upper_body")).resolves.toMatchObject({ taskId: "task-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("retries a retryable 500 response", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 500, error: "temporary" }, 500))
      .mockResolvedValueOnce(jsonResponse({ status: 200, data: { task_id: "task-2" } }));
    const client = new YouCamClient({ apiKey: "secret", fetchImpl, sleep: async () => undefined, maxRetries: 1 });
    await expect(client.createTask("src", "ref", "upper_body")).resolves.toMatchObject({ taskId: "task-2" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable 400 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 400, error: "bad" }, 400));
    const client = new YouCamClient({ apiKey: "secret", fetchImpl, sleep: async () => undefined, maxRetries: 3 });
    await expect(client.createTask("src", "ref", "upper_body")).rejects.toBeInstanceOf(YouCamHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a transient result-download failure", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response("image-bytes", { status: 200, headers: { "content-type": "image/jpeg" } }));
    const client = new YouCamClient({ apiKey: "secret", fetchImpl, sleep: async () => undefined, maxRetries: 1 });
    const result = await client.downloadResult("https://result.example/output.jpg");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.bytes.toString()).toBe("image-bytes");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

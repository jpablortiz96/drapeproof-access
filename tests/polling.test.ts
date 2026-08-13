import { describe, expect, it, vi } from "vitest";
import {
  PollingTimeoutError,
  ProviderTaskError,
  UnexpectedTaskStatusError,
} from "../src/youcam/errors.js";
import { pollTask } from "../src/youcam/polling.js";
import type { TaskStatusData } from "../src/youcam/types.js";

function status(taskStatus: string, extras: Partial<TaskStatusData> = {}): TaskStatusData {
  return { taskStatus, raw: { data: { task_status: taskStatus } }, ...extras };
}

describe("task polling", () => {
  it("records running and returns a successful result", async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce(status("running"))
      .mockResolvedValueOnce(status("success", { resultUrl: "https://example.com/result.jpg" }));
    const observed: string[] = [];
    const result = await pollTask(getStatus, {
      intervalMs: 1,
      timeoutMs: 100,
      sleep: async () => undefined,
      onObservation: (entry) => {
        observed.push(entry.task_status);
      },
    });
    expect(result.resultUrl).toContain("result.jpg");
    expect(observed).toEqual(["running", "success"]);
  });

  it("throws on provider error", async () => {
    await expect(
      pollTask(async () => status("error", { error: "error_pose" }), { intervalMs: 1, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ProviderTaskError);
  });

  it("times out without an infinite loop", async () => {
    let clock = 0;
    await expect(
      pollTask(async () => status("running"), {
        intervalMs: 50,
        timeoutMs: 100,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).rejects.toBeInstanceOf(PollingTimeoutError);
  });

  it("fails closed on an unexpected status", async () => {
    await expect(
      pollTask(async () => status("mystery"), { intervalMs: 1, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(UnexpectedTaskStatusError);
  });
});

import { PollingTimeoutError, ProviderTaskError, ResponseShapeError, UnexpectedTaskStatusError } from "./errors.js";
import type { StatusHistoryEntry, TaskStatusData } from "./types.js";

export interface PollingOptions {
  intervalMs: number;
  timeoutMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timestamp?: () => string;
  onObservation?: (entry: StatusHistoryEntry, status: TaskStatusData) => Promise<void> | void;
}

export async function pollTask(
  getStatus: () => Promise<TaskStatusData>,
  options: PollingOptions,
): Promise<TaskStatusData> {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const timestamp = options.timestamp ?? (() => new Date().toISOString());
  const started = now();

  for (;;) {
    if (now() - started >= options.timeoutMs) {
      throw new PollingTimeoutError(`YouCam task did not finish within ${options.timeoutMs} ms.`);
    }

    const status = await getStatus();
    const entry: StatusHistoryEntry = { timestamp_utc: timestamp(), task_status: status.taskStatus };
    if (status.error !== undefined && status.error !== null) entry.error = status.error;
    if (status.errorMessage) entry.error_message = status.errorMessage;
    await options.onObservation?.(entry, status);

    if (status.taskStatus === "success") {
      if (!status.resultUrl) throw new ResponseShapeError("Successful YouCam task did not include data.results.url.");
      return status;
    }
    if (status.taskStatus === "error") {
      throw new ProviderTaskError(status.errorMessage ?? "YouCam task ended with provider status error.", status.raw);
    }
    if (status.taskStatus !== "running") throw new UnexpectedTaskStatusError(status.taskStatus);

    const remaining = options.timeoutMs - (now() - started);
    if (remaining <= 0) throw new PollingTimeoutError(`YouCam task did not finish within ${options.timeoutMs} ms.`);
    await sleep(Math.min(options.intervalMs, remaining));
  }
}

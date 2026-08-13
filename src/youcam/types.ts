export type GarmentCategory = "full_body" | "lower_body" | "upper_body" | "shoes" | "auto" | "outer";

export interface FileUploadInstruction {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface InitializedFile {
  contentType: string;
  fileName: string;
  fileId: string;
  request: FileUploadInstruction;
  raw: unknown;
}

export interface CreatedTask {
  taskId: string;
  raw: unknown;
}

export interface TaskStatusData {
  taskStatus: string;
  error?: unknown;
  errorMessage?: string;
  resultUrl?: string;
  raw: unknown;
}

export interface StatusHistoryEntry {
  timestamp_utc: string;
  task_status: string;
  error?: unknown;
  error_message?: string;
}

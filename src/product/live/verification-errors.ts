export type VerificationFailureCode =
  | "VERIFIER_RUNTIME_UNAVAILABLE"
  | "VERIFIER_ASSET_MISSING"
  | "VERIFIER_INPUT_UNAVAILABLE"
  | "VERIFIER_EXECUTION_FAILED";

export class VerificationRuntimeError extends Error {
  constructor(public readonly failureCode: VerificationFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerificationRuntimeError";
  }
}

const WINDOWS_PATH = /[A-Za-z]:\\[^\s"']+/g;
const UNIX_RUNTIME_PATH = /\/(?:var\/task|tmp|home)\/[^\s"']+/g;

export function verificationFailureCode(error: unknown): VerificationFailureCode {
  if (error instanceof VerificationRuntimeError) return error.failureCode;
  const value = error as NodeJS.ErrnoException | undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (value?.code === "ENOENT" && /(?:spawn|python)/i.test(message)) return "VERIFIER_RUNTIME_UNAVAILABLE";
  if (value?.code === "ENOENT" || /pose model.*missing|continuity-policy\.json.*(?:missing|not found)/i.test(message)) return "VERIFIER_ASSET_MISSING";
  if (/source and result|input.*unavailable|private object is unavailable/i.test(message)) return "VERIFIER_INPUT_UNAVAILABLE";
  return "VERIFIER_EXECUTION_FAILED";
}

export function sanitizedVerificationError(error: unknown): {
  failureCode: VerificationFailureCode;
  errorName: string;
  runtimeCode: string | null;
  message: string;
} {
  const value = error as NodeJS.ErrnoException | undefined;
  const raw = error instanceof Error ? error.message : String(error);
  return {
    failureCode: verificationFailureCode(error),
    errorName: error instanceof Error ? error.name : "Error",
    runtimeCode: typeof value?.code === "string" ? value.code : null,
    message: raw.replace(WINDOWS_PATH, "[LOCAL_PATH]").replace(UNIX_RUNTIME_PATH, "[RUNTIME_PATH]"),
  };
}

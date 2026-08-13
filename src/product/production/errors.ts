export const ERROR_CODES = [
  "UPLOAD_INVALID", "SESSION_NOT_FOUND", "SESSION_EXPIRED", "NOT_AUTHORIZED", "RATE_LIMITED",
  "PROVIDER_REJECTED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "STORAGE_FAILURE",
  "DATABASE_FAILURE", "VERIFICATION_FAILURE", "REQUEST_INVALID", "ORIGIN_REJECTED",
] as const;

export type ProductErrorCode = typeof ERROR_CODES[number];

export class ProductionError extends Error {
  constructor(public readonly code: ProductErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ProductionError";
  }
}

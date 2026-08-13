import { createHash, createHmac, randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newAnonymousToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isAnonymousToken(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function hashAnonymousToken(token: string, secret?: string): string {
  if (!isAnonymousToken(token)) throw new Error("Anonymous ownership token is malformed.");
  return secret
    ? createHmac("sha256", secret).update("drapeproof-owner-v1\0").update(token).digest("hex")
    : createHash("sha256").update("drapeproof-owner-v1\0").update(token).digest("hex");
}

export function hashRateLimitKey(value: string, secret: string): string {
  return createHmac("sha256", secret).update("drapeproof-rate-v1\0").update(value).digest("hex");
}

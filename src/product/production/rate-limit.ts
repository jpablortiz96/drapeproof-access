import type { DatabaseClient } from "./db.js";

export type RateLimitScope = "session-create" | "upload" | "generation" | "preserve" | "status";

export interface RateLimitDecision { allowed: boolean; retryAfterSeconds: number; }
export interface RateLimiter {
  check(scope: RateLimitScope, keyHash: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
}

export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly database: DatabaseClient) {}

  async check(scope: RateLimitScope, keyHash: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const rows = await this.database.query<{ request_count: number; retry_after: number }>(`
      INSERT INTO rate_limit_buckets (scope, key_hash, window_start, window_seconds, request_count, expires_at)
      VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $4) * $4), $4, 1,
        to_timestamp(floor(extract(epoch FROM now()) / $4) * $4) + make_interval(secs => $4))
      ON CONFLICT (scope, key_hash, window_start)
      DO UPDATE SET request_count = rate_limit_buckets.request_count + 1
      WHERE rate_limit_buckets.request_count < $3
      RETURNING request_count,
        greatest(1, ceil(extract(epoch FROM (expires_at - now()))))::int AS retry_after
    `, [scope, keyHash, limit, windowSeconds]);
    return rows[0]
      ? { allowed: true, retryAfterSeconds: rows[0].retry_after }
      : { allowed: false, retryAfterSeconds: windowSeconds };
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  async check(scope: RateLimitScope, keyHash: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const now = Date.now(); const key = `${scope}:${keyHash}`; const current = this.buckets.get(key);
    const bucket = !current || current.expiresAt <= now ? { count: 0, expiresAt: now + windowSeconds * 1_000 } : current;
    if (bucket.count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1_000)) };
    bucket.count += 1; this.buckets.set(key, bucket);
    return { allowed: true, retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1_000)) };
  }
}

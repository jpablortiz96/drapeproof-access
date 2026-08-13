const DEFAULT_SESSION_TTL_HOURS = 24;
const DEFAULT_PROVIDER_DAILY_UNIT_BUDGET = 10;
const DEFAULT_PROVIDER_OPERATION_UNITS = 2;
const DEFAULT_ANALYTICS_RETENTION_DAYS = 30;

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function booleanFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false.`);
}

export interface ProductionConfig {
  youcamApiKey: string;
  databaseUrl: string;
  blobToken: string;
  ownerHashSecret: string;
  cronSecret: string;
  sessionTtlHours: number;
  generationEnabled: boolean;
  betaMode: boolean;
  providerDailyUnitBudget: number;
  providerOperationUnits: { clothing: number; bag: number };
  analyticsRetentionDays: number;
  rateLimits: {
    sessionCreatePerHour: number;
    uploadsPerTenMinutes: number;
    generationsPerHour: number;
    preservesPerTenMinutes: number;
    statusPerTenMinutes: number;
  };
}

export function generationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return booleanFlag(env, "DRAPEPROOF_GENERATION_ENABLED", env.VERCEL_ENV !== "production");
}

export function betaModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return booleanFlag(env, "DRAPEPROOF_BETA_MODE", false);
}

export function providerDailyUnitBudget(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env, "DRAPEPROOF_PROVIDER_DAILY_UNIT_BUDGET", DEFAULT_PROVIDER_DAILY_UNIT_BUDGET);
}

export function providerOperationUnits(category: "CLOTHING" | "BAG", env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(
    env,
    category === "CLOTHING" ? "DRAPEPROOF_CLOTHES_V4_UNITS" : "DRAPEPROOF_BAG_V2_UNITS",
    DEFAULT_PROVIDER_OPERATION_UNITS,
  );
}

export function analyticsRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env, "DRAPEPROOF_ANALYTICS_RETENTION_DAYS", DEFAULT_ANALYTICS_RETENTION_DAYS);
}

export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): ProductionConfig["rateLimits"] {
  return {
    sessionCreatePerHour: positiveInteger(env, "DRAPEPROOF_RATE_SESSION_CREATE_PER_HOUR", 10),
    uploadsPerTenMinutes: positiveInteger(env, "DRAPEPROOF_RATE_UPLOADS_PER_10_MIN", 20),
    generationsPerHour: positiveInteger(env, "DRAPEPROOF_RATE_GENERATIONS_PER_HOUR", 3),
    preservesPerTenMinutes: positiveInteger(env, "DRAPEPROOF_RATE_PRESERVES_PER_10_MIN", 6),
    statusPerTenMinutes: positiveInteger(env, "DRAPEPROOF_RATE_STATUS_PER_10_MIN", 360),
  };
}

export function sessionTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env, "DRAPEPROOF_SESSION_TTL_HOURS", DEFAULT_SESSION_TTL_HOURS);
}

export function usesProductionPersistence(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV === "production") return true;
  if (env.DRAPEPROOF_PERSISTENCE === "postgres-blob") return true;
  if (env.DRAPEPROOF_PERSISTENCE === "local") return false;
  return env.NODE_ENV === "production" && env.DRAPEPROOF_ALLOW_LOCAL_PRODUCTION !== "1";
}

export function loadProductionConfig(env: NodeJS.ProcessEnv = process.env): ProductionConfig {
  const required = ["YOUCAM_API_KEY", "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "DRAPEPROOF_OWNER_HASH_SECRET", "CRON_SECRET"] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Production configuration is incomplete. Missing: ${missing.join(", ")}.`);
  return {
    youcamApiKey: env.YOUCAM_API_KEY!.trim(),
    databaseUrl: env.DATABASE_URL!.trim(),
    blobToken: env.BLOB_READ_WRITE_TOKEN!.trim(),
    ownerHashSecret: env.DRAPEPROOF_OWNER_HASH_SECRET!.trim(),
    cronSecret: env.CRON_SECRET!.trim(),
    sessionTtlHours: sessionTtlHours(env),
    generationEnabled: generationEnabled(env),
    betaMode: betaModeEnabled(env),
    providerDailyUnitBudget: providerDailyUnitBudget(env),
    providerOperationUnits: {
      clothing: providerOperationUnits("CLOTHING", env),
      bag: providerOperationUnits("BAG", env),
    },
    analyticsRetentionDays: analyticsRetentionDays(env),
    rateLimits: rateLimitConfig(env),
  };
}

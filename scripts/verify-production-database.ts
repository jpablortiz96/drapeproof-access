import "dotenv/config";
import { NeonDatabaseClient } from "../src/product/production/db.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for database verification.");

const database = new NeonDatabaseClient(databaseUrl);
async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 750));
    }
  }
  throw lastError;
}

const tables = await retry(() => database.query<{ table_name: string }>(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('try_on_sessions', 'rate_limit_buckets', 'schema_migrations', 'preservation_attempts', 'provider_budget_days', 'provider_unit_reservations', 'product_events', 'beta_feedback', 'beta_cleanup_runs')
  ORDER BY table_name
`));
const indexes = await retry(() => database.query<{ indexname: string }>(`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public' AND indexname IN (
    'try_on_sessions_owner_idx', 'try_on_sessions_expires_idx',
    'try_on_sessions_status_idx', 'try_on_sessions_created_idx',
    'try_on_sessions_provider_idempotency_idx', 'rate_limit_buckets_expires_idx',
    'preservation_attempts_session_created_idx', 'preservation_attempts_cleanup_idx',
    'provider_unit_reservations_day_state_idx', 'provider_unit_reservations_session_idx',
    'product_events_occurred_idx', 'product_events_expiry_idx', 'product_events_name_occurred_idx',
    'beta_feedback_expiry_idx', 'beta_cleanup_runs_completed_idx'
  ) ORDER BY indexname
`));
const migrations = await retry(() => database.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name"));

if (tables.length !== 9 || indexes.length !== 15 || !migrations.some((row) => row.name === "0001_m6_production.sql") || !migrations.some((row) => row.name === "0002_m8b_preserve_mode.sql") || !migrations.some((row) => row.name === "0003_m9_beta_control_plane.sql")) {
  throw new Error("Production database schema verification failed.");
}

process.stdout.write(`PASS: production database has ${tables.length} required tables, ${indexes.length} required indexes, and all required migration records.\n`);

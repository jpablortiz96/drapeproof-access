CREATE TABLE IF NOT EXISTS try_on_sessions (
  id uuid PRIMARY KEY,
  anonymous_owner_hash text NOT NULL,
  category text NULL CHECK (category IS NULL OR category IN ('CLOTHING', 'BAG')),
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,

  source_blob_key text NULL,
  product_blob_key text NULL,
  provider_result_blob_key text NULL,
  passport_blob_key text NULL,

  provider_name text NOT NULL,
  provider_category text NULL,
  provider_status text NOT NULL,
  provider_error_code text NULL,
  provider_task_id text NULL,
  provider_started_at timestamptz NULL,
  provider_idempotency_key text NULL,

  continuity_status text NULL,
  continuity_payload jsonb NULL,
  protected_regions jsonb NOT NULL DEFAULT '[]'::jsonb,
  protected_region_results jsonb NULL,
  face_analysis_enabled boolean NOT NULL DEFAULT false,
  face_analysis_payload jsonb NULL,
  final_state text NOT NULL,
  stage text NOT NULL,
  session_payload jsonb NOT NULL,

  cleanup_error_code text NULL,
  cleanup_attempted_at timestamptz NULL
);

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS try_on_sessions_owner_idx ON try_on_sessions (anonymous_owner_hash);

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS try_on_sessions_expires_idx ON try_on_sessions (expires_at);

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS try_on_sessions_status_idx ON try_on_sessions (status);

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS try_on_sessions_created_idx ON try_on_sessions (created_at DESC);

-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS try_on_sessions_provider_idempotency_idx
  ON try_on_sessions (provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;

-- statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  request_count integer NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hash, window_start)
);

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS rate_limit_buckets_expires_idx ON rate_limit_buckets (expires_at);

-- statement-breakpoint
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE try_on_sessions
  ADD COLUMN IF NOT EXISTS preserved_result_blob_key text,
  ADD COLUMN IF NOT EXISTS preservation_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preservation_lock_token text,
  ADD COLUMN IF NOT EXISTS preservation_lock_expires_at timestamptz;

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS preservation_attempts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES try_on_sessions(id) ON DELETE CASCADE,
  region_id text NOT NULL,
  idempotency_key text NOT NULL,
  input_version integer NOT NULL CHECK (input_version >= 0),
  output_version integer CHECK (output_version IS NULL OR output_version >= input_version),
  state text NOT NULL CHECK (state IN ('PROCESSING','RESTORED','IMPROVED_BUT_REVIEW','UNCHANGED','FAILED','BLOCKED')),
  eligibility text NOT NULL CHECK (eligibility IN ('ELIGIBLE','BLOCKED_CONTINUITY','BLOCKED_ALIGNMENT','BLOCKED_TRANSFORM_OVERLAP','BLOCKED_TRANSFORM_PROXIMITY','BLOCKED_INSUFFICIENT_CONTEXT','NOT_NEEDED')),
  engine_version text NOT NULL CHECK (engine_version = 'PRESERVE_ENGINE_V1'),
  eligibility_policy_version text NOT NULL CHECK (eligibility_policy_version = '2.0.0'),
  intent_estimator text NOT NULL CHECK (intent_estimator = 'UpperBodyPoseIntentZoneV1'),
  source_hash text,
  provider_result_hash text,
  generated_input_hash text,
  output_hash text,
  repair_blob_key text,
  trace jsonb,
  provider_calls integer NOT NULL DEFAULT 0 CHECK (provider_calls = 0),
  youcam_units integer NOT NULL DEFAULT 0 CHECK (youcam_units = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (session_id, region_id, idempotency_key)
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS preservation_attempts_session_created_idx
  ON preservation_attempts (session_id, created_at DESC);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS preservation_attempts_cleanup_idx
  ON preservation_attempts (completed_at) WHERE repair_blob_key IS NOT NULL;

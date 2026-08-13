CREATE TABLE IF NOT EXISTS provider_budget_days (
  utc_day date PRIMARY KEY,
  configured_budget integer NOT NULL CHECK (configured_budget > 0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS provider_unit_reservations (
  reservation_key text PRIMARY KEY,
  utc_day date NOT NULL REFERENCES provider_budget_days(utc_day) ON DELETE RESTRICT,
  try_on_session_id uuid REFERENCES try_on_sessions(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('CLOTHING', 'BAG')),
  expected_units integer NOT NULL CHECK (expected_units > 0),
  state text NOT NULL CHECK (state IN ('RESERVED', 'SUBMITTED', 'UNCERTAIN', 'RELEASED')),
  provider_task_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS provider_unit_reservations_day_state_idx
  ON provider_unit_reservations (utc_day, state);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS provider_unit_reservations_session_idx
  ON provider_unit_reservations (try_on_session_id);

-- statement-breakpoint

CREATE OR REPLACE FUNCTION drapeproof_reserve_provider_units(
  p_utc_day date,
  p_budget integer,
  p_expected_units integer,
  p_reservation_key text,
  p_session_id uuid,
  p_category text
) RETURNS TABLE(decision text, reservation_state text, units_reserved integer, remaining_units integer)
LANGUAGE plpgsql
AS $$
DECLARE
  existing_state text;
  existing_units integer;
  current_reserved integer;
BEGIN
  IF p_budget <= 0 OR p_expected_units <= 0 OR p_category NOT IN ('CLOTHING', 'BAG') THEN
    RAISE EXCEPTION 'Invalid provider budget reservation input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('drapeproof-provider-budget:' || p_utc_day::text, 0));
  INSERT INTO provider_budget_days (utc_day, configured_budget, reserved_units)
    VALUES (p_utc_day, p_budget, 0)
    ON CONFLICT (utc_day) DO UPDATE SET configured_budget = EXCLUDED.configured_budget, updated_at = now();

  SELECT state, expected_units INTO existing_state, existing_units
    FROM provider_unit_reservations WHERE reservation_key = p_reservation_key;
  SELECT reserved_units INTO current_reserved FROM provider_budget_days WHERE utc_day = p_utc_day;

  IF existing_state IS NOT NULL AND existing_state <> 'RELEASED' THEN
    RETURN QUERY SELECT 'DUPLICATE'::text, existing_state, existing_units, GREATEST(0, p_budget - current_reserved);
    RETURN;
  END IF;

  IF current_reserved + p_expected_units > p_budget THEN
    RETURN QUERY SELECT 'BUDGET_EXHAUSTED'::text, NULL::text, 0, GREATEST(0, p_budget - current_reserved);
    RETURN;
  END IF;

  UPDATE provider_budget_days SET reserved_units = reserved_units + p_expected_units,
    configured_budget = p_budget, updated_at = now() WHERE utc_day = p_utc_day;
  INSERT INTO provider_unit_reservations (
    reservation_key, utc_day, try_on_session_id, category, expected_units, state, created_at, updated_at, released_at
  ) VALUES (p_reservation_key, p_utc_day, p_session_id, p_category, p_expected_units, 'RESERVED', now(), now(), NULL)
  ON CONFLICT (reservation_key) DO UPDATE SET
    utc_day = EXCLUDED.utc_day, try_on_session_id = EXCLUDED.try_on_session_id,
    category = EXCLUDED.category, expected_units = EXCLUDED.expected_units,
    state = 'RESERVED', provider_task_id = NULL, updated_at = now(), released_at = NULL;

  RETURN QUERY SELECT 'AVAILABLE'::text, 'RESERVED'::text, p_expected_units,
    GREATEST(0, p_budget - current_reserved - p_expected_units);
END;
$$;

-- statement-breakpoint

CREATE OR REPLACE FUNCTION drapeproof_release_provider_units(p_reservation_key text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  target_day date;
  target_units integer;
BEGIN
  SELECT utc_day, expected_units INTO target_day, target_units
    FROM provider_unit_reservations WHERE reservation_key = p_reservation_key AND state = 'RESERVED';
  IF target_day IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('drapeproof-provider-budget:' || target_day::text, 0));
  UPDATE provider_unit_reservations SET state = 'RELEASED', released_at = now(), updated_at = now()
    WHERE reservation_key = p_reservation_key AND state = 'RESERVED';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE provider_budget_days SET reserved_units = GREATEST(0, reserved_units - target_units), updated_at = now()
    WHERE utc_day = target_day;
  RETURN true;
END;
$$;

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS product_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_name text NOT NULL CHECK (event_name IN (
    'landing_viewed','try_started','photo_added','product_added','protect_step_viewed',
    'protected_region_added','protect_skipped','review_confirmed','generation_started',
    'provider_succeeded','provider_failed','continuity_passed','continuity_failed','result_viewed',
    'preserve_offered','preserve_blocked','preserve_started','preserve_restored','preserve_review',
    'preserve_failed','passport_viewed','passport_downloaded','session_deleted','feedback_submitted',
    'workflow_failed'
  )),
  anonymous_session_bucket text,
  try_on_session_id uuid REFERENCES try_on_sessions(id) ON DELETE SET NULL,
  category text CHECK (category IS NULL OR category IN ('CLOTHING', 'BAG')),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object'),
  deduplication_key text UNIQUE,
  expires_at timestamptz NOT NULL
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS product_events_occurred_idx ON product_events (occurred_at DESC);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS product_events_expiry_idx ON product_events (expires_at);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS product_events_name_occurred_idx ON product_events (event_name, occurred_at DESC);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS beta_feedback (
  id uuid PRIMARY KEY,
  try_on_session_id uuid NOT NULL UNIQUE REFERENCES try_on_sessions(id) ON DELETE CASCADE,
  useful boolean NOT NULL,
  reason text CHECK (reason IS NULL OR reason IN (
    'TRY_ON_UNREALISTIC','PROTECTED_AREAS_UNCLEAR','RESTORE_MORE','TOO_SLOW',
    'REUSE_PROTECTED_AREAS','SOMETHING_ELSE'
  )),
  something_else varchar(240),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (something_else IS NULL OR reason = 'SOMETHING_ELSE')
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS beta_feedback_expiry_idx ON beta_feedback (expires_at);

-- statement-breakpoint

CREATE TABLE IF NOT EXISTS beta_cleanup_runs (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
  sessions_examined integer NOT NULL DEFAULT 0,
  sessions_cleaned integer NOT NULL DEFAULT 0,
  sessions_failed integer NOT NULL DEFAULT 0,
  events_deleted integer NOT NULL DEFAULT 0,
  feedback_deleted integer NOT NULL DEFAULT 0,
  error_code text
);

-- statement-breakpoint

CREATE INDEX IF NOT EXISTS beta_cleanup_runs_completed_idx ON beta_cleanup_runs (completed_at DESC);

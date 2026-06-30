-- Phase 7.5B: Atomic Decision Snapshot Supersession
--
-- Problem: The previous TypeScript implementation ran three separate queries:
--   1. SELECT current latest (find previousLatestId)
--   2. INSERT new row with is_latest = true
--   3. UPDATE previous row to is_latest = false
--
-- Under concurrent saves for the same case_id both callers could read the same
-- previousLatestId, both INSERT with is_latest = true, and only update the shared
-- old row — leaving two rows permanently marked is_latest = true.
--
-- Solution: Single Postgres function that:
--   (a) Acquires a transaction-scoped advisory lock keyed on case_id — serializes
--       ALL concurrent saves for the same case completely.
--   (b) Clears the previous latest BEFORE inserting the new one — eliminates the
--       window where two rows simultaneously have is_latest = true even within a
--       single session.
--   (c) Runs inside a single PL/pgSQL transaction — any failure (duplicate insert,
--       constraint violation, etc.) automatically rolls back both the UPDATE and
--       the INSERT atomically.
--
-- Safety net: partial unique index guarantees at the DB level that at most one
-- is_latest = true exists per case_id, regardless of how the data is modified.
-- ============================================================================

-- 1. Partial unique index: at most one is_latest = true per case_id (safety net).
--    Works in concert with the atomic function.  Any direct INSERT that would
--    create a second is_latest = true row is rejected by the DB immediately.
create unique index if not exists legal_decisions_single_latest_idx
  on app.legal_decisions (case_id)
  where is_latest = true;

-- 2. Atomic supersession function.
create or replace function app.save_legal_decision_atomic(
  p_case_id               uuid,
  p_version_hash          text,
  p_decision_status       text,
  p_decision_data         jsonb,
  p_source_pipeline_version text  default null,
  p_created_by            uuid   default null
)
returns jsonb
language plpgsql
as $$
declare
  v_previous_id   uuid;
  v_new_row       app.legal_decisions%rowtype;
  v_existing_row  app.legal_decisions%rowtype;
begin
  -- ── Step 0: Advisory lock ────────────────────────────────────────────────
  -- Serialize all concurrent save_legal_decision_atomic calls for the same
  -- case_id.  The lock is held for the duration of the enclosing transaction
  -- and released automatically on COMMIT or ROLLBACK.
  --
  -- Two-argument form avoids cross-table collisions (first arg = table tag,
  -- second arg = case_id hash).  abs() keeps values in the positive int4 range.
  perform pg_advisory_xact_lock(
    abs(hashtext('app.legal_decisions')),
    abs(hashtext(p_case_id::text))
  );

  -- ── Step 1: Duplicate check ───────────────────────────────────────────────
  -- If this version_hash already exists for the case, return it immediately.
  -- No new snapshot is created; this is an idempotent re-call.
  select * into v_existing_row
  from app.legal_decisions
  where case_id = p_case_id
    and version_hash = p_version_hash
  limit 1;

  if found then
    return jsonb_build_object(
      '_action',                  'duplicate',
      'id',                       v_existing_row.id,
      'case_id',                  v_existing_row.case_id,
      'version_hash',             v_existing_row.version_hash,
      'decision_status',          v_existing_row.decision_status,
      'decision_data',            v_existing_row.decision_data,
      'source_pipeline_version',  v_existing_row.source_pipeline_version,
      'created_by',               v_existing_row.created_by,
      'created_at',               v_existing_row.created_at,
      'supersedes_decision_id',   v_existing_row.supersedes_decision_id,
      'is_latest',                v_existing_row.is_latest
    );
  end if;

  -- ── Step 2: Identify current latest ──────────────────────────────────────
  -- Advisory lock means no concurrent transaction can be between steps 2 and 4
  -- for the same case_id.  SELECT FOR UPDATE provides an additional row-level
  -- lock as belt-and-suspenders (catches edge cases where advisory lock is
  -- bypassed via direct SQL access).
  select id into v_previous_id
  from app.legal_decisions
  where case_id = p_case_id
    and is_latest = true
  for update;
  -- v_previous_id is NULL when this is the first snapshot for the case.

  -- ── Step 3: Clear previous latest BEFORE inserting new ───────────────────
  -- No window exists where two rows simultaneously have is_latest = true.
  -- If the subsequent INSERT fails, this UPDATE is rolled back atomically.
  if v_previous_id is not null then
    update app.legal_decisions
    set is_latest = false
    where id = v_previous_id;
    -- Note: the immutable-data trigger (prevent_legal_decision_data_update)
    -- fires here but passes because only is_latest changes, not decision_data.
  end if;

  -- ── Step 4: Insert new snapshot ──────────────────────────────────────────
  insert into app.legal_decisions (
    case_id,
    version_hash,
    decision_status,
    decision_data,
    source_pipeline_version,
    created_by,
    supersedes_decision_id,
    is_latest
  )
  values (
    p_case_id,
    p_version_hash,
    p_decision_status,
    p_decision_data,
    p_source_pipeline_version,
    p_created_by,
    v_previous_id,  -- supersedes the row we just cleared
    true
  )
  returning * into v_new_row;

  -- ── Step 5: Return inserted row ───────────────────────────────────────────
  return jsonb_build_object(
    '_action',                  'inserted',
    'id',                       v_new_row.id,
    'case_id',                  v_new_row.case_id,
    'version_hash',             v_new_row.version_hash,
    'decision_status',          v_new_row.decision_status,
    'decision_data',            v_new_row.decision_data,
    'source_pipeline_version',  v_new_row.source_pipeline_version,
    'created_by',               v_new_row.created_by,
    'created_at',               v_new_row.created_at,
    'supersedes_decision_id',   v_new_row.supersedes_decision_id,
    'is_latest',                v_new_row.is_latest
  );
end;
$$;

grant execute on function app.save_legal_decision_atomic(
  uuid, text, text, jsonb, text, uuid
) to service_role;

comment on function app.save_legal_decision_atomic is
  'Phase 7.5B: Atomically inserts a new Legal Decision snapshot and marks the '
  'previous latest as superseded.  Uses pg_advisory_xact_lock to serialize '
  'concurrent saves for the same case_id.  Never produces two is_latest=true '
  'rows for the same case_id.';

-- ============================================================================
-- SQL VERIFICATION QUERIES (run manually after applying migration)
-- ============================================================================
-- Verify partial unique index exists:
--   select indexname, indexdef
--   from pg_indexes
--   where tablename = 'legal_decisions'
--     and indexname = 'legal_decisions_single_latest_idx';
--
-- Verify function exists:
--   select routine_name, routine_type
--   from information_schema.routines
--   where routine_schema = 'app'
--     and routine_name = 'save_legal_decision_atomic';
--
-- Smoke test (requires a valid case_id from app.cases):
--   select app.save_legal_decision_atomic(
--     '<valid_case_uuid>',
--     'test-hash-001',
--     'READY',
--     '{"test": true}'::jsonb
--   );
--
-- Verify uniqueness invariant (should return 0 or at most 1 per case_id):
--   select case_id, count(*) as latest_count
--   from app.legal_decisions
--   where is_latest = true
--   group by case_id
--   having count(*) > 1;
-- ============================================================================

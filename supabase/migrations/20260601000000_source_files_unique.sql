-- AI LEGAL ARMENIA Phase 1 prerequisite.
-- Adds UNIQUE constraint on internal.source_files.raw_record_sha256 so that
-- the Phase 1 ingestion worker can use ON CONFLICT(raw_record_sha256) DO NOTHING
-- for idempotent streaming ingestion.
-- An index already exists (source_files_raw_record_sha256_idx from 018000).
-- This migration promotes it to a real UNIQUE constraint.
-- Runs after 20260530018000_security_and_pipeline_patch.sql.

-- Idempotent: migration 018000 may have already added this exact constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'source_files_raw_record_sha256_unique'
      and conrelid = 'internal.source_files'::regclass
  ) then
    alter table internal.source_files
      add constraint source_files_raw_record_sha256_unique
      unique (raw_record_sha256);
  end if;
end $$;

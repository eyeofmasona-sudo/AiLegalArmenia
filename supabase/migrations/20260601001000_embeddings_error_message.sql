-- AI LEGAL ARMENIA Phase 5 prerequisite.
-- Adds error_message column to public.embeddings for Cohere API failure logging.
-- Migration 018000 already adds this column via ADD COLUMN IF NOT EXISTS.
-- This migration is idempotent (IF NOT EXISTS) and can safely run even if
-- 018000 already ran.
-- Runs after 20260601000000_source_files_unique.sql.

alter table public.embeddings
  add column if not exists error_message text;

comment on column public.embeddings.error_message is
  'Cohere API error message when status=failed. Null on success.';

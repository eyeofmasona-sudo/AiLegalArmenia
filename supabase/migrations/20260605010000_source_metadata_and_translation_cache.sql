-- AI LEGAL ARMENIA — ECHR support: document source metadata + fragment translation cache.
-- Idempotent. Runs after 20260605000000_embedding_model_v2.sql.

-- 1) Provenance / source metadata on documents (ECHR: appno, articles, conclusion, ecli, dates...).
alter table public.documents
  add column if not exists source_metadata jsonb;

create index if not exists documents_source_metadata_gin
  on public.documents using gin (source_metadata);

comment on column public.documents.source_metadata is
  'Source-specific structured metadata (e.g. ECHR: appno, ecli, articles, conclusion, respondent). Free-form jsonb.';

-- 2) Translation cache: store Armenian translations of search-result fragments only.
--    Original EN/FR text is never pre-translated; we translate on demand and cache here.
create table if not exists public.fragment_translations (
  translation_id  uuid primary key default gen_random_uuid(),
  chunk_id        uuid not null references public.search_chunks(chunk_id) on delete cascade,
  source_lang     text not null,
  target_lang     text not null default 'hy',
  source_sha256   text not null,                 -- sha256 of source fragment -> detect stale cache
  translated_text text not null,
  model           text not null,                 -- translation model/provider id
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (chunk_id, target_lang)
);

create index if not exists fragment_translations_chunk_idx
  on public.fragment_translations (chunk_id);

comment on table public.fragment_translations is
  'On-demand Armenian (or other) translations of search-result fragments, keyed by chunk. Originals stay EN/FR.';

alter table public.fragment_translations enable row level security;

drop policy if exists fragment_translations_read on public.fragment_translations;
create policy fragment_translations_read
  on public.fragment_translations for select
  to authenticated
  using (true);

-- writes go through service_role (search/translate worker); no authenticated write policy.
grant select on public.fragment_translations to authenticated;
grant select, insert, update on public.fragment_translations to service_role;

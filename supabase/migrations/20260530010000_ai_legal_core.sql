-- AI LEGAL ARMENIA database repair baseline.
-- Sources: Promt-map-for-database.txt, Roadmap-,-database-repair-map.txt,
-- final_architecture.md, Gemini_repair.txt, user decisions 2026-05-30.

create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;

create schema if not exists app;
create schema if not exists internal;

do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'app'::regnamespace and typname = 'app_role') then
    create type app.app_role as enum ('admin', 'lawyer', 'client');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'content_domain') then
    create type public.content_domain as enum ('knowledge_base', 'practice', 'unknown');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'normalized_status') then
    create type public.normalized_status as enum ('active', 'repealed', 'partially_active', 'draft', 'unknown');
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on extension vector is
  'pgvector support for embeddings. ANN index is intentionally deferred until stable chunk count is known.';


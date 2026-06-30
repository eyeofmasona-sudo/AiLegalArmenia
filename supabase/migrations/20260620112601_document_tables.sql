-- AI LEGAL ARMENIA - extracted PDF tables DDL.
-- Data backfill is intentionally handled by a separate resumable script.

create table if not exists public.document_tables (
  table_id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(document_id) on delete cascade,
  version_id uuid not null references public.document_versions(version_id) on delete cascade,
  page_from int check (page_from > 0),
  page_to int check (page_to >= page_from),
  index_on_page int,
  n_rows int,
  n_cols int,
  headers jsonb,
  table_markdown text,
  source_sha256 text,
  extraction_tool text,
  extraction_confidence numeric check (extraction_confidence between 0 and 100),
  table_class text check (table_class in ('real_grid', 'meta_header', 'body_text', 'placeholder', 'unknown')) default 'unknown',
  needs_human_review boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (version_id, page_from, index_on_page)
);

create table if not exists public.document_table_cells (
  cell_id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.document_tables(table_id) on delete cascade,
  row_idx int not null,
  col_idx int not null,
  value_raw text,
  value_norm text,
  value_type text check (value_type in ('text', 'number', 'date', 'percent', 'currency', 'code', 'empty')) default 'text',
  cell_confidence numeric check (cell_confidence between 0 and 100),
  unique (table_id, row_idx, col_idx)
);

create index if not exists document_tables_document_id_idx
  on public.document_tables (document_id);

create index if not exists document_tables_version_id_idx
  on public.document_tables (version_id);

create index if not exists document_tables_table_class_idx
  on public.document_tables (table_class);

create index if not exists document_tables_needs_human_review_idx
  on public.document_tables (needs_human_review);

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'set_updated_at'
      and tgrelid = 'public.document_tables'::regclass
  ) then
    create trigger set_updated_at
      before update on public.document_tables
      for each row execute function public.set_updated_at();
  end if;
end $$;

alter table public.document_tables enable row level security;
alter table public.document_table_cells enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'document_tables'
      and policyname = 'corpus_read'
  ) then
    create policy corpus_read on public.document_tables
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'document_tables'
      and policyname = 'corpus_write'
  ) then
    create policy corpus_write on public.document_tables
      for all to service_role using (true) with check (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'document_table_cells'
      and policyname = 'corpus_read'
  ) then
    create policy corpus_read on public.document_table_cells
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'document_table_cells'
      and policyname = 'corpus_write'
  ) then
    create policy corpus_write on public.document_table_cells
      for all to service_role using (true) with check (true);
  end if;
end $$;

grant select on public.document_tables to authenticated;
grant select on public.document_table_cells to authenticated;
grant all on public.document_tables to service_role;
grant all on public.document_table_cells to service_role;

-- AI LEGAL ARMENIA legal corpus, search, and internal provenance schema.

create table internal.ingestion_jobs (
  job_id uuid primary key default gen_random_uuid(),
  source_file_path text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running',
  total_records integer not null default 0 check (total_records >= 0),
  failed_records integer not null default 0 check (failed_records >= 0),
  report_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_jobs_status_check check (status in ('running', 'done', 'failed'))
);

create table internal.source_files (
  source_file_id uuid primary key default gen_random_uuid(),
  job_id uuid references internal.ingestion_jobs(job_id) on delete set null,
  raw_record jsonb,
  source_path text,
  source_url text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  file_sha256 text,
  raw_record_sha256 text,
  text_sha256 text,
  quarantined boolean not null default false,
  quarantine_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_files_raw_record_check check (quarantined or raw_record is not null)
);

create table internal.extraction_runs (
  run_id uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references internal.source_files(source_file_id) on delete cascade,
  extraction_tool text,
  extraction_status text not null,
  errors jsonb not null default '[]'::jsonb,
  traceback text,
  extracted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint extraction_runs_status_check check (extraction_status in ('success', 'failed', 'partial'))
);

create table public.document_types (
  document_type_id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label_hy text,
  label_ru text,
  label_en text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.jurisdictions (
  jurisdiction_id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_hy text,
  name_ru text,
  name_en text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.authorities (
  authority_id uuid primary key default gen_random_uuid(),
  name_raw text not null,
  name_normalized text,
  authority_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.publication_sources (
  source_id uuid primary key default gen_random_uuid(),
  name text not null,
  source_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.documents (
  document_id uuid primary key default gen_random_uuid(),
  canonical_key text unique,
  arlis_doc_id text,
  document_type_id uuid references public.document_types(document_type_id) on delete restrict,
  jurisdiction_id uuid references public.jurisdictions(jurisdiction_id) on delete restrict,
  content_domain public.content_domain not null default 'unknown',
  title_hy text,
  title_ru text,
  title_en text,
  doc_number_raw text,
  doc_number_clean text,
  issued_date date,
  effective_from date,
  effective_to date,
  raw_status text,
  normalized_status public.normalized_status not null default 'unknown',
  quality_flags jsonb not null default '[]'::jsonb,
  needs_human_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_versions (
  version_id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(document_id) on delete cascade,
  version_number integer not null check (version_number > 0),
  source_file_id uuid references internal.source_files(source_file_id) on delete restrict,
  full_text text,
  text_sha256 text,
  page_count integer check (page_count is null or page_count >= 0),
  language_code text not null default 'hy',
  is_current boolean not null default true,
  publication_source_id uuid references public.publication_sources(source_id) on delete restrict,
  published_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, version_number)
);

create table public.document_pages (
  page_id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.document_versions(version_id) on delete cascade,
  page_number integer not null check (page_number > 0),
  page_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (version_id, page_number)
);

create table public.version_authorities (
  version_authority_id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.document_versions(version_id) on delete cascade,
  authority_id uuid not null references public.authorities(authority_id) on delete restrict,
  authority_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (version_id, authority_id, authority_role)
);

create table public.topics (
  topic_id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label_hy text,
  label_ru text,
  label_en text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_topics (
  document_topic_id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(document_id) on delete cascade,
  topic_id uuid not null references public.topics(topic_id) on delete restrict,
  assigned_by text,
  confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, topic_id),
  constraint document_topics_confidence_check check (confidence is null or confidence between 0 and 1)
);

create table public.knowledge_document_profiles (
  profile_id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references public.documents(document_id) on delete cascade,
  has_articles boolean,
  has_chapters boolean,
  classifier_confidence numeric,
  classifier_method text,
  classified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_document_profiles_classifier_confidence_check
    check (classifier_confidence is null or classifier_confidence between 0 and 1)
);

create table public.practice_document_profiles (
  profile_id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references public.documents(document_id) on delete cascade,
  case_number text,
  court_level text,
  verdict_type text,
  classifier_confidence numeric,
  classifier_method text,
  classified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint practice_document_profiles_classifier_confidence_check
    check (classifier_confidence is null or classifier_confidence between 0 and 1)
);

create table public.legal_units (
  unit_id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(document_id) on delete cascade,
  version_id uuid not null references public.document_versions(version_id) on delete cascade,
  parent_unit_id uuid references public.legal_units(unit_id) on delete cascade,
  unit_type text,
  unit_number text,
  unit_title text,
  unit_text text,
  sort_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_references (
  reference_id uuid primary key default gen_random_uuid(),
  from_document_id uuid not null references public.documents(document_id) on delete cascade,
  to_document_id uuid references public.documents(document_id) on delete set null,
  reference_type text,
  reference_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.practice_to_knowledge_references (
  ref_id uuid primary key default gen_random_uuid(),
  practice_doc_id uuid not null references public.documents(document_id) on delete cascade,
  knowledge_doc_id uuid references public.documents(document_id) on delete set null,
  reference_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.search_chunks (
  chunk_id uuid primary key default gen_random_uuid(),
  chunk_key text not null unique,
  document_id uuid not null references public.documents(document_id) on delete cascade,
  version_id uuid not null references public.document_versions(version_id) on delete cascade,
  legal_unit_id uuid references public.legal_units(unit_id) on delete set null,
  text text not null,
  token_count integer check (token_count is null or token_count >= 0),
  page_from integer check (page_from is null or page_from > 0),
  page_to integer check (page_to is null or page_to > 0),
  char_start integer check (char_start is null or char_start >= 0),
  char_end integer check (char_end is null or char_end >= 0),
  language_code text not null default 'hy',
  content_domain public.content_domain not null default 'unknown',
  norm_status public.normalized_status not null default 'unknown',
  effective_from date,
  effective_to date,
  source_url text,
  citation_anchor text,
  chunk_text_sha256 text not null,
  fts_vector tsvector generated always as (to_tsvector('simple', coalesce(text, ''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint search_chunks_page_range_check check (page_from is null or page_to is null or page_to >= page_from),
  constraint search_chunks_char_range_check check (char_start is null or char_end is null or char_end >= char_start)
);

create table public.embeddings (
  embedding_id uuid primary key default gen_random_uuid(),
  chunk_id uuid not null references public.search_chunks(chunk_id) on delete cascade,
  model text not null,
  dimension integer not null,
  vector vector(1024),
  chunk_text_sha256 text,
  status text not null default 'pending',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chunk_id, model),
  constraint embeddings_dimension_check check (dimension = 1024),
  constraint embeddings_status_check check (status in ('pending', 'success', 'failed'))
);

create index ingestion_jobs_status_idx on internal.ingestion_jobs (status);
create index source_files_job_id_idx on internal.source_files (job_id);
create index source_files_file_sha256_idx on internal.source_files (file_sha256);
create index source_files_raw_record_sha256_idx on internal.source_files (raw_record_sha256);
create index extraction_runs_source_file_id_idx on internal.extraction_runs (source_file_id);

create index documents_document_type_id_idx on public.documents (document_type_id);
create index documents_jurisdiction_id_idx on public.documents (jurisdiction_id);
create index documents_content_status_idx on public.documents (content_domain, normalized_status);
create index documents_effective_dates_idx on public.documents (effective_from, effective_to);
create index documents_doc_number_clean_trgm_idx on public.documents using gin (doc_number_clean gin_trgm_ops);
create index documents_title_hy_trgm_idx on public.documents using gin (title_hy gin_trgm_ops);
create index documents_title_ru_trgm_idx on public.documents using gin (title_ru gin_trgm_ops);

create index document_versions_document_id_idx on public.document_versions (document_id);
create index document_versions_source_file_id_idx on public.document_versions (source_file_id);
create index document_versions_publication_source_id_idx on public.document_versions (publication_source_id);
create index document_versions_current_idx on public.document_versions (document_id, is_current);
create index document_pages_version_id_idx on public.document_pages (version_id);
create index version_authorities_version_id_idx on public.version_authorities (version_id);
create index version_authorities_authority_id_idx on public.version_authorities (authority_id);
create index document_topics_document_id_idx on public.document_topics (document_id);
create index document_topics_topic_id_idx on public.document_topics (topic_id);
create index knowledge_document_profiles_document_id_idx on public.knowledge_document_profiles (document_id);
create index practice_document_profiles_document_id_idx on public.practice_document_profiles (document_id);
create index legal_units_document_id_idx on public.legal_units (document_id);
create index legal_units_version_id_idx on public.legal_units (version_id);
create index legal_units_parent_unit_id_idx on public.legal_units (parent_unit_id);
create index document_references_from_document_id_idx on public.document_references (from_document_id);
create index document_references_to_document_id_idx on public.document_references (to_document_id);
create index practice_to_knowledge_references_practice_doc_id_idx on public.practice_to_knowledge_references (practice_doc_id);
create index practice_to_knowledge_references_knowledge_doc_id_idx on public.practice_to_knowledge_references (knowledge_doc_id);
create index search_chunks_document_id_idx on public.search_chunks (document_id);
create index search_chunks_version_id_idx on public.search_chunks (version_id);
create index search_chunks_legal_unit_id_idx on public.search_chunks (legal_unit_id);
create index search_chunks_fts_vector_idx on public.search_chunks using gin (fts_vector);
create index search_chunks_content_status_idx on public.search_chunks (content_domain, norm_status);
create index search_chunks_effective_dates_idx on public.search_chunks (effective_from, effective_to);
create index embeddings_chunk_id_idx on public.embeddings (chunk_id);
create index embeddings_model_status_idx on public.embeddings (model, status);

-- DATA_GAP: Armenian FTS requires a real text search configuration. The current
-- fts_vector uses the PostgreSQL simple configuration only as schema support.
-- DATA_GAP: ANN vector index is intentionally deferred until stable chunk count:
-- <100K chunks: consider hnsw (m=16, ef_construction=64)
-- 100K-1M chunks: consider hnsw (m=16, ef_construction=128)
-- >1M chunks: benchmark hnsw vs ivfflat with lists based on sqrt(n).
-- Optional later, after performance tests:
-- create index search_chunks_text_trgm_idx on public.search_chunks using gin (text gin_trgm_ops);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'internal.ingestion_jobs',
    'internal.source_files',
    'internal.extraction_runs',
    'public.document_types',
    'public.jurisdictions',
    'public.authorities',
    'public.publication_sources',
    'public.documents',
    'public.document_versions',
    'public.document_pages',
    'public.version_authorities',
    'public.topics',
    'public.document_topics',
    'public.knowledge_document_profiles',
    'public.practice_document_profiles',
    'public.legal_units',
    'public.document_references',
    'public.practice_to_knowledge_references',
    'public.search_chunks',
    'public.embeddings'
  ]
  loop
    execute format(
      'create trigger set_updated_at before update on %s for each row execute function public.set_updated_at()',
      table_name
    );
  end loop;
end $$;

alter table internal.ingestion_jobs enable row level security;
alter table internal.source_files enable row level security;
alter table internal.extraction_runs enable row level security;

create policy internal_service_only on internal.ingestion_jobs
  for all to service_role using (true) with check (true);
create policy internal_service_only on internal.source_files
  for all to service_role using (true) with check (true);
create policy internal_service_only on internal.extraction_runs
  for all to service_role using (true) with check (true);

alter table public.document_types enable row level security;
alter table public.jurisdictions enable row level security;
alter table public.authorities enable row level security;
alter table public.publication_sources enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_pages enable row level security;
alter table public.version_authorities enable row level security;
alter table public.topics enable row level security;
alter table public.document_topics enable row level security;
alter table public.knowledge_document_profiles enable row level security;
alter table public.practice_document_profiles enable row level security;
alter table public.legal_units enable row level security;
alter table public.document_references enable row level security;
alter table public.practice_to_knowledge_references enable row level security;
alter table public.search_chunks enable row level security;
alter table public.embeddings enable row level security;

create policy corpus_read on public.document_types for select to authenticated using (true);
create policy corpus_write on public.document_types for all to service_role using (true) with check (true);
create policy corpus_read on public.jurisdictions for select to authenticated using (true);
create policy corpus_write on public.jurisdictions for all to service_role using (true) with check (true);
create policy corpus_read on public.authorities for select to authenticated using (true);
create policy corpus_write on public.authorities for all to service_role using (true) with check (true);
create policy corpus_read on public.publication_sources for select to authenticated using (true);
create policy corpus_write on public.publication_sources for all to service_role using (true) with check (true);
create policy corpus_read on public.documents for select to authenticated using (true);
create policy corpus_write on public.documents for all to service_role using (true) with check (true);
create policy corpus_read on public.document_versions for select to authenticated using (true);
create policy corpus_write on public.document_versions for all to service_role using (true) with check (true);
create policy corpus_read on public.document_pages for select to authenticated using (true);
create policy corpus_write on public.document_pages for all to service_role using (true) with check (true);
create policy corpus_read on public.version_authorities for select to authenticated using (true);
create policy corpus_write on public.version_authorities for all to service_role using (true) with check (true);
create policy corpus_read on public.topics for select to authenticated using (true);
create policy corpus_write on public.topics for all to service_role using (true) with check (true);
create policy corpus_read on public.document_topics for select to authenticated using (true);
create policy corpus_write on public.document_topics for all to service_role using (true) with check (true);
create policy corpus_read on public.knowledge_document_profiles for select to authenticated using (true);
create policy corpus_write on public.knowledge_document_profiles for all to service_role using (true) with check (true);
create policy corpus_read on public.practice_document_profiles for select to authenticated using (true);
create policy corpus_write on public.practice_document_profiles for all to service_role using (true) with check (true);
create policy corpus_read on public.legal_units for select to authenticated using (true);
create policy corpus_write on public.legal_units for all to service_role using (true) with check (true);
create policy corpus_read on public.document_references for select to authenticated using (true);
create policy corpus_write on public.document_references for all to service_role using (true) with check (true);
create policy corpus_read on public.practice_to_knowledge_references for select to authenticated using (true);
create policy corpus_write on public.practice_to_knowledge_references for all to service_role using (true) with check (true);
create policy corpus_read on public.search_chunks for select to authenticated using (true);
create policy corpus_write on public.search_chunks for all to service_role using (true) with check (true);
create policy corpus_read on public.embeddings for select to authenticated using (true);
create policy corpus_write on public.embeddings for all to service_role using (true) with check (true);

grant usage on schema internal to service_role;
grant all on all tables in schema internal to service_role;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;


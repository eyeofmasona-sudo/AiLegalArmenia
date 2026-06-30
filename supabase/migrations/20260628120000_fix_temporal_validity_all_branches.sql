-- =============================================================================
-- MIGRATION: Fix temporal validity in ALL branches of search_legal_corpus_dual
-- Date: 2026-06-28
-- Author: Senior Supabase/Postgres RAG Engineer
--
-- PROBLEM (audit 2026-06-28):
--   The live RPC search_legal_corpus_dual (captured in 20260627030000) correctly
--   applies temporal filtering in metric_candidates but OMITS it in:
--     - bm25_candidates  → CRITICAL: active fallback path, unfiltered by date
--     - qwen_candidates  → dead path (p_qwen_embedding always null) but wrong
--
--   Additionally, when p_effective_at IS NULL the function silently returns
--   potentially stale results with no caller warning.
--
-- CHANGES (surgical — does NOT touch embedding pipeline or RRF fusion):
--   1. bm25_candidates:  add effective_from/effective_to temporal guard
--   2. qwen_candidates:  add effective_from/effective_to temporal guard
--   3. p_norm_status default: null → 'active' (safe: all callers already pass 'active')
--   4. Final SELECT: append ':effective_date_missing' to match_reason when
--      p_effective_at IS NULL, so callers can detect the unanchored-date case
--
-- UNCHANGED: metric_ann, qwen_ann, settings CTEs; RRF fusion; unioned/ranked/rrf/best
-- logic; return columns; indexes; grants.
--
-- SAFE TO RE-RUN: CREATE OR REPLACE — idempotent.
-- =============================================================================

create or replace function public.search_legal_corpus_dual(
  p_query_text        text,
  p_metric_embedding  vector default null,
  p_qwen_embedding    vector default null,
  p_content_domain    public.content_domain default null,
  -- FIX #3: default changed from NULL to 'active'.
  -- Rationale: every production caller (vector-search, kb-search, kb-unified-search)
  -- already passes p_norm_status='active' explicitly. Changing the default prevents
  -- a future caller from accidentally retrieving repealed/unknown norms.
  p_norm_status       public.normalized_status default 'active',
  p_limit             integer default 10,
  p_metric_limit      integer default 30,
  p_qwen_limit        integer default 30,
  p_bm25_limit        integer default 30,
  p_effective_at      date default null
)
returns table (
  chunk_id uuid, document_id uuid, version_id uuid, doc_id text, title text,
  text_snippet text, source_url text, citation_anchor text, language text,
  source text, content_domain public.content_domain, norm_status public.normalized_status,
  score real, vector_score real, fts_score real, retrieval_model text,
  retrieval_route text, match_reason text
)
language sql
stable
set search_path to 'public', 'extensions', 'pg_temp'
set statement_timeout to '15000'
as $function$
  -- -----------------------------------------------------------------------
  -- settings — unchanged
  -- -----------------------------------------------------------------------
  with settings as (
    select least(greatest(coalesce(p_limit,10),1),100)        as final_limit,
           least(greatest(coalesce(p_metric_limit,30),1),100) as metric_limit,
           least(greatest(coalesce(p_qwen_limit,30),1),100)   as qwen_limit,
           least(greatest(coalesce(p_bm25_limit,30),1),120)   as bm25_limit,
           nullif(trim(coalesce(p_query_text,'')),'')          as query_text
  ),
  -- -----------------------------------------------------------------------
  -- ANN materialized CTEs — unchanged
  -- -----------------------------------------------------------------------
  metric_ann as materialized (
    select e.chunk_id, (1.0-(e.vector <=> p_metric_embedding))::float4 as sim
    from public.embeddings e
    where p_metric_embedding is not null
      and e.model  = 'armenian-text-embeddings-2-large'
      and e.status = 'success'
    order by e.vector <=> p_metric_embedding
    limit (select metric_limit from settings)
  ),
  qwen_ann as materialized (
    select e.chunk_id, (1.0-(e.vector <=> p_qwen_embedding))::float4 as sim
    from public.embeddings e
    where p_qwen_embedding is not null
      and e.model  = 'qwen3-embedding-0.6b'
      and e.status = 'success'
    order by e.vector <=> p_qwen_embedding
    limit (select qwen_limit from settings)
  ),
  -- -----------------------------------------------------------------------
  -- metric_candidates — ALREADY CORRECT (temporal filter present since baseline)
  -- Documented here for completeness; no logic changed.
  -- -----------------------------------------------------------------------
  metric_candidates as (
    select sc.chunk_id, sc.document_id, sc.version_id,
           d.canonical_key as doc_id,
           coalesce(d.title_hy, d.title_en, d.title_ru, d.canonical_key) as title,
           left(sc.text, 900) as text_snippet,
           sc.source_url, sc.citation_anchor, sc.language_code as language,
           case
             when d.canonical_key like 'venice:%' then 'venice'
             when d.arlis_doc_id is not null      then 'arlis'
             else coalesce(d.source_metadata->>'source', 'armenian_legal')
           end as source,
           sc.content_domain, sc.norm_status,
           a.sim           as score,
           a.sim           as vector_score,
           0.0::float4     as fts_score,
           'armenian-text-embeddings-2-large'::text as retrieval_model,
           'metric_hy'::text                        as retrieval_route,
           'metric_dense'::text                     as match_reason
    from metric_ann a
    join public.search_chunks sc    on sc.chunk_id  = a.chunk_id
    join public.document_versions dv on dv.version_id = sc.version_id
                                     and dv.is_current = true           -- ✅ current revision
    join public.documents d          on d.document_id  = sc.document_id
    where sc.language_code = 'hy'
      and d.canonical_key not like 'echr:%'
      and (p_content_domain is null or sc.content_domain = p_content_domain)
      and (p_norm_status    is null or sc.norm_status    = p_norm_status)
      -- ✅ temporal filter — present in baseline, unchanged:
      and (
        p_effective_at   is null
        or sc.effective_from is null
        or (sc.effective_from <= p_effective_at
            and (sc.effective_to is null or sc.effective_to > p_effective_at))
      )
  ),
  -- -----------------------------------------------------------------------
  -- qwen_candidates — FIX #1: add effective_from / effective_to guard
  -- (path is currently dead because vector-search passes p_qwen_embedding=null,
  --  but the filter must be correct for when it is re-enabled)
  -- -----------------------------------------------------------------------
  qwen_candidates as (
    select sc.chunk_id, sc.document_id, sc.version_id,
           d.canonical_key as doc_id,
           coalesce(d.title_en, d.title_hy, d.title_ru, d.canonical_key) as title,
           left(sc.text, 900) as text_snippet,
           sc.source_url, sc.citation_anchor, sc.language_code as language,
           'echr'::text as source,
           sc.content_domain, sc.norm_status,
           a.sim           as score,
           a.sim           as vector_score,
           0.0::float4     as fts_score,
           'qwen3-embedding-0.6b'::text as retrieval_model,
           'qwen_echr'::text            as retrieval_route,
           'qwen_dense'::text           as match_reason
    from qwen_ann a
    join public.search_chunks sc     on sc.chunk_id   = a.chunk_id
    join public.document_versions dv  on dv.version_id  = sc.version_id
                                      and dv.is_current = true           -- ✅ current revision
    join public.documents d           on d.document_id  = sc.document_id
    where d.canonical_key like 'echr:%'
      and sc.language_code in ('en', 'fr')
      and (p_content_domain is null or sc.content_domain = p_content_domain)
      and (p_norm_status    is null or sc.norm_status    = p_norm_status)
      -- FIX #1 ✅ — temporal filter now matches metric_candidates:
      and (
        p_effective_at   is null
        or sc.effective_from is null
        or (sc.effective_from <= p_effective_at
            and (sc.effective_to is null or sc.effective_to > p_effective_at))
      )
  ),
  -- -----------------------------------------------------------------------
  -- bm25_candidates — FIX #2 (CRITICAL): add effective_from / effective_to guard
  -- This is the active fallback path executed whenever p_metric_embedding is null
  -- (e.g. embedding endpoint down, cold cache, or kb-search / kb-unified-search).
  -- Without this filter, BM25 was returning chunks from ANY revision regardless
  -- of the event date — a critical correctness bug for legal expert systems.
  -- -----------------------------------------------------------------------
  bm25_candidates as (
    select sc.chunk_id, sc.document_id, sc.version_id,
           d.canonical_key as doc_id,
           coalesce(d.title_hy, d.title_en, d.title_ru, d.canonical_key) as title,
           left(sc.text, 900) as text_snippet,
           sc.source_url, sc.citation_anchor, sc.language_code as language,
           case
             when d.canonical_key like 'echr:%'   then 'echr'
             when d.canonical_key like 'venice:%' then 'venice'
             when d.arlis_doc_id is not null       then 'arlis'
             else coalesce(d.source_metadata->>'source', 'legal')
           end as source,
           sc.content_domain, sc.norm_status,
           ts_rank_cd(sc.fts_vector, websearch_to_tsquery('simple', s.query_text))::float4 as score,
           0.0::float4 as vector_score,
           ts_rank_cd(sc.fts_vector, websearch_to_tsquery('simple', s.query_text))::float4 as fts_score,
           'fts:simple'::text  as retrieval_model,
           'bm25_fts'::text    as retrieval_route,
           'fts'::text         as match_reason
    from public.search_chunks sc
    join public.document_versions dv on dv.version_id = sc.version_id
                                     and dv.is_current = true           -- ✅ current revision
    join public.documents d          on d.document_id  = sc.document_id
    cross join settings s
    where s.query_text is not null
      and sc.fts_vector @@ websearch_to_tsquery('simple', s.query_text)
      and (p_content_domain is null or sc.content_domain = p_content_domain)
      and (p_norm_status    is null or sc.norm_status    = p_norm_status)
      -- FIX #2 ✅ — temporal filter, identical guard used in metric_candidates:
      and (
        p_effective_at   is null
        or sc.effective_from is null
        or (sc.effective_from <= p_effective_at
            and (sc.effective_to is null or sc.effective_to > p_effective_at))
      )
    order by ts_rank_cd(sc.fts_vector, websearch_to_tsquery('simple', s.query_text)) desc
    limit (select bm25_limit from settings)
  ),
  -- -----------------------------------------------------------------------
  -- RRF fusion pipeline — unchanged
  -- -----------------------------------------------------------------------
  unioned as (
    select * from metric_candidates
    union all
    select * from qwen_candidates
    union all
    select * from bm25_candidates
  ),
  ranked as (
    select u.*, row_number() over (partition by retrieval_route order by score desc) as rnk
    from unioned u
  ),
  rrf as (
    select chunk_id, sum(1.0/(60.0+rnk))::float4 as rrf_score
    from ranked
    group by chunk_id
  ),
  best as (
    select distinct on (chunk_id) *
    from ranked
    order by chunk_id,
      case retrieval_route
        when 'metric_hy'  then 3
        when 'qwen_echr'  then 3
        when 'bm25_fts'   then 2
        else 1
      end desc,
      score desc
  )
  -- -----------------------------------------------------------------------
  -- Final SELECT — FIX #3: encode effective_date_missing warning in match_reason
  -- When p_effective_at IS NULL the caller has not anchored results to an event
  -- date. All chunks pass the temporal guard (guard is vacuously true) so results
  -- may include any revision that is current. The suffix signals this to callers:
  --   "metric_dense:effective_date_missing"
  --   "fts:effective_date_missing"
  -- Callers that care about the warning check for the suffix; callers that do not
  -- care are unaffected (match_reason is informational only).
  -- -----------------------------------------------------------------------
  select
    b.chunk_id, b.document_id, b.version_id, b.doc_id, b.title,
    b.text_snippet, b.source_url, b.citation_anchor, b.language,
    b.source, b.content_domain, b.norm_status,
    r.rrf_score   as score,
    b.vector_score,
    b.fts_score,
    b.retrieval_model,
    b.retrieval_route,
    -- FIX #3 ✅: append warning suffix when effective date is unknown
    case when p_effective_at is null
         then b.match_reason || ':effective_date_missing'
         else b.match_reason
    end           as match_reason
  from best b
  join rrf r using (chunk_id)
  order by r.rrf_score desc
  limit (select final_limit from settings);
$function$;

-- Re-grant with updated signature (p_norm_status default changed; signature unchanged)
grant execute on function public.search_legal_corpus_dual(
  text, vector, vector, public.content_domain, public.normalized_status,
  integer, integer, integer, integer, date
) to authenticated, service_role;

comment on function public.search_legal_corpus_dual(
  text, vector, vector, public.content_domain, public.normalized_status,
  integer, integer, integer, integer, date
) is
'2026-06-28 temporal fix: (1) bm25_candidates now applies effective_from/to guard
(critical — active fallback path was unfiltered by event date); (2) qwen_candidates
same guard added (dead path, correctness); (3) p_norm_status default changed null→active;
(4) match_reason carries :effective_date_missing suffix when p_effective_at IS NULL.
metric_candidates and RRF fusion pipeline unchanged. Previous baseline: 2026-06-27.';

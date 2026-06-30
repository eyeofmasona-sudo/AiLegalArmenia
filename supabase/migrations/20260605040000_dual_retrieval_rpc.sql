-- AI LEGAL ARMENIA -- Dual Index Retrieval RPC.
-- Keeps the existing search_legal_corpus() API intact and adds a separate
-- production path for Metric-AI Armenian + Qwen ECHR retrieval.

drop index if exists public.embeddings_hnsw_idx;

create index if not exists embeddings_hnsw_metric_idx
  on public.embeddings using hnsw (vector vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where model = 'armenian-text-embeddings-2-large' and status = 'success';

create index if not exists embeddings_hnsw_qwen_idx
  on public.embeddings using hnsw (vector vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where model = 'qwen3-embedding-0.6b' and status = 'success';

create index if not exists search_chunks_language_created_idx
  on public.search_chunks (language_code, created_at, chunk_id);

create index if not exists search_chunks_echr_practice_idx
  on public.search_chunks (content_domain, language_code, created_at, chunk_id)
  where content_domain = 'practice' and language_code in ('en', 'fr');

create index if not exists documents_canonical_key_pattern_idx
  on public.documents (canonical_key text_pattern_ops);

comment on index public.embeddings_hnsw_metric_idx is
  'Dual Index: Metric-AI armenian-text-embeddings-2-large only. Do not mix Qwen vectors in this ANN index.';

comment on index public.embeddings_hnsw_qwen_idx is
  'Dual Index: Qwen3-Embedding-0.6B ECHR vectors only. Do not mix Metric vectors in this ANN index.';

create or replace function public.search_legal_corpus_dual(
  p_query_text        text,
  p_metric_embedding  vector(1024) default null,
  p_qwen_embedding    vector(1024) default null,
  p_limit             integer default 10,
  p_metric_limit      integer default 30,
  p_qwen_limit        integer default 30,
  p_bm25_limit        integer default 30,
  p_effective_at      date default null
)
returns table (
  chunk_id        uuid,
  document_id     uuid,
  version_id      uuid,
  doc_id          text,
  title           text,
  text_snippet    text,
  source_url      text,
  citation_anchor text,
  language        text,
  source          text,
  content_domain  public.content_domain,
  norm_status     public.normalized_status,
  score           float4,
  vector_score    float4,
  fts_score       float4,
  retrieval_model text,
  retrieval_route text,
  match_reason    text
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with settings as (
    select
      least(greatest(coalesce(p_limit, 10), 1), 100) as final_limit,
      least(greatest(coalesce(p_metric_limit, 30), 1), 200) as metric_limit,
      least(greatest(coalesce(p_qwen_limit, 30), 1), 200) as qwen_limit,
      least(greatest(coalesce(p_bm25_limit, 30), 1), 200) as bm25_limit,
      nullif(trim(coalesce(p_query_text, '')), '') as query_text
  ),
  metric_candidates as (
    select
      sc.chunk_id,
      sc.document_id,
      sc.version_id,
      d.canonical_key as doc_id,
      coalesce(d.title_hy, d.title_en, d.title_ru, d.canonical_key) as title,
      left(sc.text, 900) as text_snippet,
      sc.source_url,
      sc.citation_anchor,
      sc.language_code as language,
      case
        when d.canonical_key like 'venice:%' then 'venice'
        when d.arlis_doc_id is not null then 'arlis'
        else coalesce(d.source_metadata->>'source', 'armenian_legal')
      end as source,
      sc.content_domain,
      sc.norm_status,
      (1.0 - (e.vector <=> p_metric_embedding))::float4 as score,
      (1.0 - (e.vector <=> p_metric_embedding))::float4 as vector_score,
      0.0::float4 as fts_score,
      'armenian-text-embeddings-2-large'::text as retrieval_model,
      'metric_hy'::text as retrieval_route,
      'metric_dense'::text as match_reason
    from public.embeddings e
    join public.search_chunks sc on sc.chunk_id = e.chunk_id
    join public.document_versions dv on dv.version_id = sc.version_id and dv.is_current = true
    join public.documents d on d.document_id = sc.document_id
    cross join settings s
    where p_metric_embedding is not null
      and e.model = 'armenian-text-embeddings-2-large'
      and e.status = 'success'
      and sc.language_code = 'hy'
      and d.canonical_key not like 'echr:%'
      and sc.norm_status = 'active'
      and (
        p_effective_at is null
        or sc.effective_from is null
        or (sc.effective_from <= p_effective_at and (sc.effective_to is null or sc.effective_to > p_effective_at))
      )
    order by e.vector <=> p_metric_embedding
    limit (select metric_limit from settings)
  ),
  qwen_candidates as (
    select
      sc.chunk_id,
      sc.document_id,
      sc.version_id,
      d.canonical_key as doc_id,
      coalesce(d.title_en, d.title_hy, d.title_ru, d.canonical_key) as title,
      left(sc.text, 900) as text_snippet,
      sc.source_url,
      sc.citation_anchor,
      sc.language_code as language,
      'echr'::text as source,
      sc.content_domain,
      sc.norm_status,
      (1.0 - (e.vector <=> p_qwen_embedding))::float4 as score,
      (1.0 - (e.vector <=> p_qwen_embedding))::float4 as vector_score,
      0.0::float4 as fts_score,
      'qwen3-embedding-0.6b'::text as retrieval_model,
      'qwen_echr'::text as retrieval_route,
      'qwen_dense'::text as match_reason
    from public.embeddings e
    join public.search_chunks sc on sc.chunk_id = e.chunk_id
    join public.document_versions dv on dv.version_id = sc.version_id and dv.is_current = true
    join public.documents d on d.document_id = sc.document_id
    cross join settings s
    where p_qwen_embedding is not null
      and e.model = 'qwen3-embedding-0.6b'
      and e.status = 'success'
      and d.canonical_key like 'echr:%'
      and sc.language_code in ('en', 'fr')
      and sc.norm_status = 'active'
    order by e.vector <=> p_qwen_embedding
    limit (select qwen_limit from settings)
  ),
  bm25_candidates as (
    select
      sc.chunk_id,
      sc.document_id,
      sc.version_id,
      d.canonical_key as doc_id,
      coalesce(d.title_hy, d.title_en, d.title_ru, d.canonical_key) as title,
      left(sc.text, 900) as text_snippet,
      sc.source_url,
      sc.citation_anchor,
      sc.language_code as language,
      case
        when d.canonical_key like 'echr:%' then 'echr'
        when d.canonical_key like 'venice:%' then 'venice'
        when d.arlis_doc_id is not null then 'arlis'
        else coalesce(d.source_metadata->>'source', 'legal')
      end as source,
      sc.content_domain,
      sc.norm_status,
      least(1.0, ts_rank_cd(sc.fts_vector, websearch_to_tsquery('simple', s.query_text)) * 10.0)::float4 as score,
      0.0::float4 as vector_score,
      ts_rank_cd(sc.fts_vector, websearch_to_tsquery('simple', s.query_text))::float4 as fts_score,
      'fts:simple'::text as retrieval_model,
      'bm25'::text as retrieval_route,
      'fts'::text as match_reason
    from public.search_chunks sc
    join public.document_versions dv on dv.version_id = sc.version_id and dv.is_current = true
    join public.documents d on d.document_id = sc.document_id
    cross join settings s
    where s.query_text is not null
      and sc.fts_vector @@ websearch_to_tsquery('simple', s.query_text)
      and sc.norm_status = 'active'
    order by ts_rank_cd(sc.fts_vector, websearch_to_tsquery('simple', s.query_text)) desc
    limit (select bm25_limit from settings)
  ),
  unioned as (
    select * from metric_candidates
    union all
    select * from qwen_candidates
    union all
    select * from bm25_candidates
  ),
  deduped as (
    select *,
      row_number() over (
        partition by chunk_id
        order by
          case retrieval_route
            when 'metric_hy' then 3
            when 'qwen_echr' then 3
            when 'bm25' then 2
            else 1
          end desc,
          score desc
      ) as rn
    from unioned
  )
  select
    chunk_id, document_id, version_id, doc_id, title, text_snippet, source_url,
    citation_anchor, language, source, content_domain, norm_status, score,
    vector_score, fts_score, retrieval_model, retrieval_route, match_reason
  from deduped
  where rn = 1
  order by score desc
  limit (select final_limit from settings);
$$;

comment on function public.search_legal_corpus_dual(
  text, vector, vector, integer, integer, integer, integer, date
) is
  'Dual Index Retrieval RPC. Metric-AI hy and Qwen ECHR use separate model-filtered ANN indexes; BM25 is fused and deduped. Exact lookup stays outside this RPC with higher priority.';

grant execute on function public.search_legal_corpus_dual(
  text, vector, vector, integer, integer, integer, integer, date
) to authenticated, service_role;

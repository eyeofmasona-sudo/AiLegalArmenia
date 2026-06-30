-- AI LEGAL ARMENIA — switch vector search to the Armenian open-source model.
-- Model: Metric-AI/armenian-text-embeddings-2-large  (DB id: 'armenian-text-embeddings-2-large')
-- base intfloat/multilingual-e5-large, 1024-dim, cosine (L2-normalized vectors).
-- Replaces the previous Cohere 'embed-multilingual-v3.0' model filter.
-- CREATE OR REPLACE keeps existing grants and signature -> frontend callers unaffected.
-- Idempotent. Runs after 20260604200000_embedding_metrics.sql.

create or replace function public.search_legal_corpus(
  p_query_text        text,
  p_query_embedding   vector(1024),
  p_content_domain    public.content_domain    default null,
  p_norm_status       public.normalized_status default 'active',
  p_effective_at      date                     default null,
  p_language_code     text                     default null,
  p_limit             integer                  default 10,
  p_offset            integer                  default 0
)
returns table (
  chunk_id        uuid,
  document_id     uuid,
  version_id      uuid,
  title_hy        text,
  text_snippet    text,
  source_url      text,
  citation_anchor text,
  page_from       integer,
  page_to         integer,
  content_domain  public.content_domain,
  norm_status     public.normalized_status,
  effective_from  date,
  effective_to    date,
  hybrid_score    float4,
  vector_score    float4,
  fts_score       float4,
  match_reason    text
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with
  filtered as (
    select
      sc.chunk_id, sc.document_id, sc.version_id, sc.text, sc.source_url,
      sc.citation_anchor, sc.page_from, sc.page_to, sc.content_domain,
      sc.norm_status, sc.effective_from, sc.effective_to, sc.fts_vector,
      e.vector as embedding_vector,
      d.title_hy
    from public.search_chunks sc
    join public.document_versions dv
      on dv.version_id = sc.version_id and dv.is_current = true
    join public.documents d
      on d.document_id = sc.document_id
    left join public.embeddings e
      on e.chunk_id = sc.chunk_id
     and e.model    = 'armenian-text-embeddings-2-large'
     and e.status   = 'success'
    where
      (p_content_domain is null or sc.content_domain = p_content_domain)
      and (p_norm_status   is null or sc.norm_status   = p_norm_status)
      and (p_language_code is null or sc.language_code = p_language_code)
      and (
        p_effective_at is null
        or (sc.effective_from <= p_effective_at
            and (sc.effective_to is null or sc.effective_to > p_effective_at))
      )
  ),
  vector_scored as (
    select *,
      case when embedding_vector is not null
           then 1.0 - (embedding_vector <=> p_query_embedding)
           else 0.0 end as vector_score
    from filtered
  ),
  fts_scored as (
    select *,
      case when p_query_text is not null and p_query_text <> ''
           then ts_rank_cd(fts_vector, plainto_tsquery('simple', p_query_text))
           else 0.0 end as fts_score
    from vector_scored
  ),
  hybrid as (
    select *,
      (0.6 * vector_score)
      + (0.3 * fts_score)
      + (0.1 * case norm_status
                 when 'active'           then 1.0
                 when 'partially_active' then 0.5
                 else 0.0 end)
      as hybrid_score
    from fts_scored
  )
  select
    chunk_id, document_id, version_id, title_hy,
    left(text, 300) as text_snippet,
    source_url, citation_anchor, page_from, page_to,
    content_domain, norm_status, effective_from, effective_to,
    hybrid_score::float4, vector_score::float4, fts_score::float4,
    case
      when vector_score > 0.7 and fts_score > 0.01 then 'vector+fts'
      when vector_score > 0.7                       then 'vector'
      when fts_score > 0.01                         then 'fts'
      else 'metadata_only'
    end as match_reason
  from hybrid
  where hybrid_score > 0.01
  order by hybrid_score desc
  limit p_limit offset p_offset;
$$;

comment on function public.search_legal_corpus(
  text, vector, public.content_domain, public.normalized_status,
  date, text, integer, integer
) is
  'Hybrid legal corpus search. 0.6 vector (Metric-AI armenian-text-embeddings-2-large, cosine) + 0.3 FTS (tsvector simple) + 0.1 norm_status boost. SECURITY INVOKER.';

-- Embedding coverage metrics: default to the Armenian model, price 0 (self-hosted, no per-token cost).
create or replace function public.get_embedding_metrics(p_model text default 'armenian-text-embeddings-2-large')
returns table (
  model text,
  total_chunks bigint,
  embedded bigint,
  pending bigint,
  failed bigint,
  est_total_tokens bigint,
  est_total_cost_usd numeric,
  est_remaining_cost_usd numeric
)
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  price_per_m numeric := 0.0;  -- self-hosted open-source model: no per-token cost
begin
  if app.get_my_role() <> 'admin' then
    raise exception 'Only admin may read embedding metrics' using errcode = '42501';
  end if;
  return query
  with sc as (
    select s.chunk_id,
           ceil(length(coalesce(s.text,'')) / 4.0)::bigint as toks,
           exists (
             select 1 from public.embeddings e
             where e.chunk_id = s.chunk_id and e.model = p_model and e.status = 'success'
           ) as done
    from public.search_chunks s
  )
  select
    p_model,
    count(*)::bigint,
    count(*) filter (where done)::bigint,
    count(*) filter (where not done)::bigint,
    (select count(*) from public.embeddings em where em.model = p_model and em.status = 'failed')::bigint,
    coalesce(sum(toks),0)::bigint,
    round(coalesce(sum(toks),0) / 1000000.0 * price_per_m, 4),
    round(coalesce(sum(toks) filter (where not done),0) / 1000000.0 * price_per_m, 4)
  from sc;
end;
$$;

grant execute on function public.get_embedding_metrics(text) to authenticated;

-- AI LEGAL ARMENIA Phase 6: Hybrid search RPC.
-- Creates public.search_legal_corpus(). Weights: 0.6 vector + 0.3 FTS + 0.1 metadata boost.
-- SECURITY INVOKER: caller's RLS context applies to search_chunks and embeddings.
-- Runs after 20260601001000_embeddings_error_message.sql.

create or replace function public.search_legal_corpus(
  p_query_text        text,
  p_query_embedding   vector(1024),
  p_content_domain    public.content_domain   default null,
  p_norm_status       public.normalized_status default 'active',
  p_effective_at      date                   default null,
  p_language_code     text                   default null,
  p_limit             integer                default 10,
  p_offset            integer                default 0
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
      sc.chunk_id,
      sc.document_id,
      sc.version_id,
      sc.text,
      sc.source_url,
      sc.citation_anchor,
      sc.page_from,
      sc.page_to,
      sc.content_domain,
      sc.norm_status,
      sc.effective_from,
      sc.effective_to,
      sc.fts_vector,
      e.vector         as embedding_vector,
      d.title_hy
    from public.search_chunks sc
    join public.document_versions dv
      on dv.version_id = sc.version_id
     and dv.is_current = true
    join public.documents d
      on d.document_id = sc.document_id
    left join public.embeddings e
      on e.chunk_id = sc.chunk_id
     and e.model     = 'embed-multilingual-v3.0'
     and e.status    = 'success'
    where
      (p_content_domain is null or sc.content_domain = p_content_domain)
      and (p_norm_status  is null or sc.norm_status   = p_norm_status)
      and (p_language_code is null or sc.language_code = p_language_code)
      and (
        p_effective_at is null
        or (
          sc.effective_from <= p_effective_at
          and (sc.effective_to is null or sc.effective_to > p_effective_at)
        )
      )
  ),
  vector_scored as (
    select
      *,
      case
        when embedding_vector is not null
          then 1.0 - (embedding_vector <=> p_query_embedding)
        else 0.0
      end as vector_score
    from filtered
  ),
  fts_scored as (
    select
      *,
      case
        when p_query_text is not null and p_query_text <> ''
          then ts_rank_cd(fts_vector, plainto_tsquery('simple', p_query_text))
        else 0.0
      end as fts_score
    from vector_scored
  ),
  hybrid as (
    select
      *,
      (0.6 * vector_score)
      + (0.3 * fts_score)
      + (0.1 * case norm_status
                 when 'active'           then 1.0
                 when 'partially_active' then 0.5
                 else 0.0
               end)
      as hybrid_score
    from fts_scored
  )
  select
    chunk_id,
    document_id,
    version_id,
    title_hy,
    left(text, 300)   as text_snippet,
    source_url,
    citation_anchor,
    page_from,
    page_to,
    content_domain,
    norm_status,
    effective_from,
    effective_to,
    hybrid_score::float4,
    vector_score::float4,
    fts_score::float4,
    case
      when vector_score > 0.7 and fts_score > 0.01 then 'vector+fts'
      when vector_score > 0.7                       then 'vector'
      when fts_score > 0.01                         then 'fts'
      else 'metadata_only'
    end as match_reason
  from hybrid
  where hybrid_score > 0.01
  order by hybrid_score desc
  limit p_limit
  offset p_offset;
$$;

comment on function public.search_legal_corpus(
  text, vector, public.content_domain, public.normalized_status,
  date, text, integer, integer
) is
  'Hybrid legal corpus search. Weights: 0.6 vector (Cohere cosine) + 0.3 FTS (tsvector simple) + 0.1 norm_status boost. Filters: content_domain, norm_status, effective_at (as-of-date), language_code. SECURITY INVOKER: caller RLS applies.';

grant execute on function public.search_legal_corpus(
  text, vector, public.content_domain, public.normalized_status,
  date, text, integer, integer
) to authenticated, service_role;

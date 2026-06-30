-- Local compatibility candidate only.
-- Current active runtime does not call match_search_chunks, and the linked live
-- project does not expose it. Do not treat this RPC as live-required unless a
-- real active caller is introduced.

create or replace function public.match_search_chunks(
  query_embedding vector(1024),
  match_model text default null,
  match_count integer default 10,
  content_domain_filter public.content_domain default null,
  reference_date date default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  version_id uuid,
  title_hy text,
  title_ru text,
  title_en text,
  text text,
  citation_anchor text,
  source_url text,
  content_domain public.content_domain,
  norm_status public.normalized_status,
  similarity float4,
  rank integer
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select
    sc.chunk_id,
    sc.document_id,
    sc.version_id,
    d.title_hy,
    d.title_ru,
    d.title_en,
    sc.text,
    sc.citation_anchor,
    sc.source_url,
    sc.content_domain,
    sc.norm_status,
    (1.0 - (e.vector <=> query_embedding))::float4 as similarity,
    row_number() over (order by e.vector <=> query_embedding)::integer as rank
  from public.embeddings e
  join public.search_chunks sc on sc.chunk_id = e.chunk_id
  join public.document_versions dv on dv.version_id = sc.version_id and dv.is_current = true
  join public.documents d on d.document_id = sc.document_id
  where e.status = 'success'
    and e.model = coalesce(match_model, 'armenian-text-embeddings-2-large')
    and (content_domain_filter is null or sc.content_domain = content_domain_filter)
    and (
      reference_date is null
      or sc.effective_from is null
      or (sc.effective_from <= reference_date and (sc.effective_to is null or sc.effective_to > reference_date))
    )
  order by e.vector <=> query_embedding
  limit least(greatest(coalesce(match_count, 10), 1), 100);
$$;

grant execute on function public.match_search_chunks(
  vector, text, integer, public.content_domain, date
) to authenticated, service_role;

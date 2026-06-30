-- Temporal-aware exact citation lookup for anchor retrieval.

create or replace function public.lookup_by_citation(
  p_citation text default null,
  p_limit integer default 10,
  p_effective_at date default null
)
returns table (
  match_type text,
  document_id uuid,
  version_id uuid,
  chunk_id uuid,
  legal_unit_id uuid,
  canonical_key text,
  arlis_doc_id text,
  doc_number_clean text,
  title_hy text,
  title_ru text,
  unit_type text,
  unit_number text,
  unit_title text,
  text text,
  source_url text,
  citation_anchor text,
  page_from integer,
  page_to integer,
  effective_from date,
  effective_to date,
  rank_score real
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with input as (
    select
      regexp_replace(lower(coalesce(p_citation, '')), '[^[:alnum:]]+', '', 'g') as citation_norm,
      regexp_replace(
        lower(coalesce(
          substring(
            coalesce(p_citation, '')
            from '(?:article|art\.?|статья|ст\.?|հոդված)[[:space:]]*([[:alnum:]./-]+)'
          ),
          ''
        )),
        '[^[:alnum:]]+',
        '',
        'g'
      ) as article_norm,
      least(greatest(coalesce(p_limit, 10), 0), 50) as result_limit
  ),
  rows as (
    select
      d.document_id,
      sc.version_id,
      sc.chunk_id,
      sc.legal_unit_id,
      d.canonical_key,
      d.arlis_doc_id,
      d.doc_number_clean,
      d.title_hy,
      d.title_ru,
      lu.unit_type,
      lu.unit_number,
      lu.unit_title,
      sc.text,
      sc.source_url,
      sc.citation_anchor,
      sc.page_from,
      sc.page_to,
      coalesce(sc.effective_from, d.effective_from) as effective_from,
      coalesce(sc.effective_to, d.effective_to) as effective_to,
      regexp_replace(lower(coalesce(sc.citation_anchor, '')), '[^[:alnum:]]+', '', 'g') as anchor_norm,
      regexp_replace(lower(coalesce(d.canonical_key, '')), '[^[:alnum:]]+', '', 'g') as canonical_norm,
      regexp_replace(lower(coalesce(d.arlis_doc_id, '')), '[^[:alnum:]]+', '', 'g') as arlis_norm,
      regexp_replace(lower(coalesce(d.doc_number_clean, '')), '[^[:alnum:]]+', '', 'g') as doc_number_norm,
      regexp_replace(lower(coalesce(lu.unit_number, '')), '[^[:alnum:]]+', '', 'g') as unit_number_norm
    from public.search_chunks sc
    join public.document_versions dv
      on dv.version_id = sc.version_id
    join public.documents d
      on d.document_id = sc.document_id
    left join public.legal_units lu
      on lu.unit_id = sc.legal_unit_id
    where (p_effective_at is not null or dv.is_current = true)
      and (sc.norm_status is null or sc.norm_status = 'active'::public.normalized_status)
      and (p_effective_at is null or sc.effective_from is null or sc.effective_from <= p_effective_at)
      and (p_effective_at is null or sc.effective_to is null or sc.effective_to > p_effective_at)
  )
  select
    case
      when r.anchor_norm <> '' and r.anchor_norm = i.citation_norm then 'citation_anchor'
      when r.anchor_norm <> '' and i.citation_norm like '%' || r.anchor_norm || '%' then 'citation_anchor'
      when i.article_norm <> '' then 'citation_article'
      else 'citation_document'
    end::text as match_type,
    r.document_id,
    r.version_id,
    r.chunk_id,
    r.legal_unit_id,
    r.canonical_key,
    r.arlis_doc_id,
    r.doc_number_clean,
    r.title_hy,
    r.title_ru,
    r.unit_type,
    r.unit_number,
    r.unit_title,
    r.text,
    r.source_url,
    r.citation_anchor,
    r.page_from,
    r.page_to,
    r.effective_from,
    r.effective_to,
    case
      when r.anchor_norm <> '' and r.anchor_norm = i.citation_norm then 1.0
      when r.anchor_norm <> '' and i.citation_norm like '%' || r.anchor_norm || '%' then 0.95
      when i.article_norm <> '' and r.unit_number_norm = i.article_norm then 0.9
      else 0.75
    end::real as rank_score
  from input i
  join rows r on true
  where
    i.citation_norm <> ''
    and (
      (r.anchor_norm <> '' and (r.anchor_norm = i.citation_norm or i.citation_norm like '%' || r.anchor_norm || '%'))
      or (
        (
          (length(r.canonical_norm) >= 3 and i.citation_norm like '%' || r.canonical_norm || '%')
          or (length(r.arlis_norm) >= 3 and i.citation_norm like '%' || r.arlis_norm || '%')
          or (length(r.doc_number_norm) >= 3 and i.citation_norm like '%' || r.doc_number_norm || '%')
        )
        and (i.article_norm = '' or r.unit_number_norm = i.article_norm)
      )
    )
  order by rank_score desc, r.title_hy nulls last, r.page_from nulls last
  limit (select result_limit from input);
$$;

grant execute on function public.lookup_by_citation(text, integer, date) to authenticated, service_role;

comment on function public.lookup_by_citation(text, integer, date) is
'Temporal-aware exact citation lookup. Current searches require current revision; historical searches return the chunk version valid on p_effective_at.';

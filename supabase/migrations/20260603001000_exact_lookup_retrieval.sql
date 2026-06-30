-- AI LEGAL ARMENIA exact-lookup retrieval RPCs.
-- SECURITY INVOKER: caller RLS applies to documents, legal_units, and search_chunks.

create index if not exists documents_canonical_key_lookup_idx
  on public.documents ((regexp_replace(lower(coalesce(canonical_key, '')), '[^[:alnum:]]+', '', 'g')));

create index if not exists documents_arlis_doc_id_lookup_idx
  on public.documents ((regexp_replace(lower(coalesce(arlis_doc_id, '')), '[^[:alnum:]]+', '', 'g')));

create index if not exists documents_doc_number_clean_lookup_idx
  on public.documents ((regexp_replace(lower(coalesce(doc_number_clean, '')), '[^[:alnum:]]+', '', 'g')));

create index if not exists legal_units_unit_number_lookup_idx
  on public.legal_units ((regexp_replace(lower(coalesce(unit_number, '')), '[^[:alnum:]]+', '', 'g')));

create index if not exists search_chunks_citation_anchor_lookup_idx
  on public.search_chunks ((regexp_replace(lower(coalesce(citation_anchor, '')), '[^[:alnum:]]+', '', 'g')));

create or replace function public.lookup_by_article(
  p_document_ref text default null,
  p_article_number text default null,
  p_limit integer default 10
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
      regexp_replace(lower(coalesce(p_document_ref, '')), '[^[:alnum:]]+', '', 'g') as document_ref_norm,
      regexp_replace(lower(coalesce(p_article_number, '')), '[^[:alnum:]]+', '', 'g') as article_norm,
      least(greatest(coalesce(p_limit, 10), 0), 50) as result_limit
  )
  select
    'article'::text as match_type,
    d.document_id,
    lu.version_id,
    sc.chunk_id,
    lu.unit_id as legal_unit_id,
    d.canonical_key,
    d.arlis_doc_id,
    d.doc_number_clean,
    d.title_hy,
    d.title_ru,
    lu.unit_type,
    lu.unit_number,
    lu.unit_title,
    coalesce(sc.text, lu.unit_text) as text,
    sc.source_url,
    sc.citation_anchor,
    sc.page_from,
    sc.page_to,
    coalesce(sc.effective_from, d.effective_from) as effective_from,
    coalesce(sc.effective_to, d.effective_to) as effective_to,
    case
      when lower(coalesce(lu.unit_type, '')) in ('article', 'հոդված', 'статья') then 1.0
      else 0.9
    end::real as rank_score
  from input i
  join public.legal_units lu
    on regexp_replace(lower(coalesce(lu.unit_number, '')), '[^[:alnum:]]+', '', 'g') = i.article_norm
  join public.document_versions dv
    on dv.version_id = lu.version_id
   and dv.is_current = true
  join public.documents d
    on d.document_id = lu.document_id
  left join public.search_chunks sc
    on sc.legal_unit_id = lu.unit_id
  where
    i.article_norm <> ''
    and (
      i.document_ref_norm = ''
      or regexp_replace(lower(coalesce(d.canonical_key, '')), '[^[:alnum:]]+', '', 'g') = i.document_ref_norm
      or regexp_replace(lower(coalesce(d.arlis_doc_id, '')), '[^[:alnum:]]+', '', 'g') = i.document_ref_norm
      or regexp_replace(lower(coalesce(d.doc_number_clean, '')), '[^[:alnum:]]+', '', 'g') = i.document_ref_norm
    )
  order by
    rank_score desc,
    d.title_hy nulls last,
    lu.sort_order nulls last,
    sc.char_start nulls last
  limit (select result_limit from input);
$$;

create or replace function public.lookup_by_citation(
  p_citation text default null,
  p_limit integer default 10
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
     and dv.is_current = true
    join public.documents d
      on d.document_id = sc.document_id
    left join public.legal_units lu
      on lu.unit_id = sc.legal_unit_id
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
  order by
    rank_score desc,
    r.title_hy nulls last,
    r.page_from nulls last
  limit (select result_limit from input);
$$;

create or replace function public.lookup_table_rows(
  p_document_ref text default null,
  p_table_ref text default null,
  p_limit integer default 50
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
      regexp_replace(lower(coalesce(p_document_ref, '')), '[^[:alnum:]]+', '', 'g') as document_ref_norm,
      regexp_replace(lower(coalesce(p_table_ref, '')), '[^[:alnum:]]+', '', 'g') as table_ref_norm,
      least(greatest(coalesce(p_limit, 50), 0), 200) as result_limit
  )
  select
    'table_row'::text as match_type,
    d.document_id,
    lu.version_id,
    sc.chunk_id,
    lu.unit_id as legal_unit_id,
    d.canonical_key,
    d.arlis_doc_id,
    d.doc_number_clean,
    d.title_hy,
    d.title_ru,
    lu.unit_type,
    lu.unit_number,
    lu.unit_title,
    coalesce(sc.text, lu.unit_text) as text,
    sc.source_url,
    sc.citation_anchor,
    sc.page_from,
    sc.page_to,
    coalesce(sc.effective_from, d.effective_from) as effective_from,
    coalesce(sc.effective_to, d.effective_to) as effective_to,
    case
      when lower(coalesce(lu.unit_type, '')) in ('table_row', 'row') then 1.0
      when lower(coalesce(lu.unit_type, '')) = 'table' then 0.9
      else 0.75
    end::real as rank_score
  from input i
  join public.legal_units lu
    on true
  join public.document_versions dv
    on dv.version_id = lu.version_id
   and dv.is_current = true
  join public.documents d
    on d.document_id = lu.document_id
  left join public.search_chunks sc
    on sc.legal_unit_id = lu.unit_id
  where
    (
      lower(coalesce(lu.unit_type, '')) in ('table', 'table_row', 'row', 'աղյուսակ', 'таблица')
      or coalesce(lu.unit_title, '') ~* '(table|աղյուսակ|таблиц)'
      or coalesce(sc.citation_anchor, '') ~* '(table|աղյուսակ|таблиц)'
    )
    and (
      i.document_ref_norm = ''
      or regexp_replace(lower(coalesce(d.canonical_key, '')), '[^[:alnum:]]+', '', 'g') = i.document_ref_norm
      or regexp_replace(lower(coalesce(d.arlis_doc_id, '')), '[^[:alnum:]]+', '', 'g') = i.document_ref_norm
      or regexp_replace(lower(coalesce(d.doc_number_clean, '')), '[^[:alnum:]]+', '', 'g') = i.document_ref_norm
    )
    and (
      i.table_ref_norm = ''
      or regexp_replace(lower(coalesce(lu.unit_number, '')), '[^[:alnum:]]+', '', 'g') = i.table_ref_norm
      or regexp_replace(lower(coalesce(lu.unit_title, '')), '[^[:alnum:]]+', '', 'g') like '%' || i.table_ref_norm || '%'
      or regexp_replace(lower(coalesce(sc.citation_anchor, '')), '[^[:alnum:]]+', '', 'g') like '%' || i.table_ref_norm || '%'
    )
  order by
    rank_score desc,
    d.title_hy nulls last,
    lu.sort_order nulls last,
    sc.char_start nulls last
  limit (select result_limit from input);
$$;

comment on function public.lookup_by_article(text, text, integer) is
  'Exact article lookup by document identifier (canonical_key, arlis_doc_id, or doc_number_clean) and legal_units.unit_number. SECURITY INVOKER: caller RLS applies.';

comment on function public.lookup_by_citation(text, integer) is
  'Exact citation lookup against search_chunks.citation_anchor plus document identifiers and optional article markers. SECURITY INVOKER: caller RLS applies.';

comment on function public.lookup_table_rows(text, text, integer) is
  'Exact lookup for table-like legal_units/search_chunks, optionally scoped by document identifier and table reference. SECURITY INVOKER: caller RLS applies.';

grant execute on function public.lookup_by_article(text, text, integer) to authenticated, service_role;
grant execute on function public.lookup_by_citation(text, integer) to authenticated, service_role;
grant execute on function public.lookup_table_rows(text, text, integer) to authenticated, service_role;

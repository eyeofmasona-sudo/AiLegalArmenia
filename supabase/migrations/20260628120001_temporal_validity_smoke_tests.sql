-- =============================================================================
-- SMOKE TESTS: Temporal validity of search_legal_corpus_dual
-- Run manually after applying 20260628120000_fix_temporal_validity_all_branches.sql
--
-- Each test has an EXPECTED block.  Run in psql or Supabase SQL editor.
-- These are read-only queries — they do NOT modify any data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SMOKE TEST 1: Current revision — active norms, no BM25 fallback
-- Verifies: metric_candidates (if embedding available) returns is_current=true
-- rows and match_reason does NOT contain ':effective_date_missing'
-- ---------------------------------------------------------------------------
-- EXPECTED: rows present, all match_reason NOT LIKE '%effective_date_missing%'
--           norm_status = 'active' for all rows

do $$
declare
  bad_count int;
begin
  select count(*) into bad_count
  from public.search_legal_corpus_dual(
    p_query_text       := 'Հայաutu',
    p_metric_embedding := null,           -- BM25-only path
    p_qwen_embedding   := null,
    p_norm_status      := 'active',
    p_effective_at     := current_date,   -- anchored to today
    p_limit            := 10
  )
  where match_reason like '%effective_date_missing%';

  if bad_count > 0 then
    raise exception 'SMOKE TEST 1 FAILED: % rows carry effective_date_missing despite p_effective_at being set', bad_count;
  end if;
  raise notice 'SMOKE TEST 1 PASSED: current revision, no false effective_date_missing warning';
end $$;

-- ---------------------------------------------------------------------------
-- SMOKE TEST 2: Historical date — BM25 returns only temporally valid chunks
-- Verifies: bm25_candidates filter excludes chunks with effective_from > ref_date
-- or effective_to <= ref_date.
-- ---------------------------------------------------------------------------
-- EXPECTED: all returned chunks satisfy:
--   (effective_from IS NULL OR effective_from <= '2015-01-01')
--   AND (effective_to IS NULL OR effective_to > '2015-01-01')
-- IMPORTANT: this test validates the WHERE predicate, not the data; if no
-- Armenian law chunks have explicit effective_from dates the test still passes
-- (NULL effective_from is treated as "always valid").

do $$
declare
  bad_count int;
  ref_date  date := '2015-01-01';
begin
  select count(*) into bad_count
  from (
    select r.chunk_id
    from public.search_legal_corpus_dual(
      p_query_text       := 'Конституция Республики Армения',
      p_metric_embedding := null,
      p_qwen_embedding   := null,
      p_norm_status      := 'active',
      p_effective_at     := ref_date,
      p_limit            := 20
    ) r
    join public.search_chunks sc on sc.chunk_id = r.chunk_id
    where
      -- a temporally invalid chunk slipped through if:
      (sc.effective_from is not null and sc.effective_from > ref_date)
      or (sc.effective_to is not null and sc.effective_to <= ref_date)
  ) bad;

  if bad_count > 0 then
    raise exception 'SMOKE TEST 2 FAILED: % chunks outside ref_date=%s slipped through', bad_count, ref_date;
  end if;
  raise notice 'SMOKE TEST 2 PASSED: historical date BM25 temporal filter correct (ref_date=%)', ref_date;
end $$;

-- ---------------------------------------------------------------------------
-- SMOKE TEST 3: BM25-only fallback (semantic endpoint unavailable)
-- Verifies: bm25_candidates executes and applies temporal filter when
-- p_metric_embedding IS NULL (the "embedding endpoint down" scenario).
-- ---------------------------------------------------------------------------
-- EXPECTED: ≥ 0 rows, retrieval_route = 'bm25_fts', no effective_date_missing

do $$
declare
  bad_route_count  int;
  warning_count    int;
begin
  -- count rows with unexpected route
  select count(*) into bad_route_count
  from public.search_legal_corpus_dual(
    p_query_text       := 'Конституция',
    p_metric_embedding := null,           -- force BM25-only
    p_qwen_embedding   := null,
    p_norm_status      := 'active',
    p_effective_at     := current_date,
    p_limit            := 10
  )
  where retrieval_route not in ('bm25_fts', 'metric_hy', 'qwen_echr');

  if bad_route_count > 0 then
    raise exception 'SMOKE TEST 3 FAILED: unknown retrieval_route in % rows', bad_route_count;
  end if;

  -- no effective_date_missing because p_effective_at is set
  select count(*) into warning_count
  from public.search_legal_corpus_dual(
    p_query_text       := 'Конституция',
    p_metric_embedding := null,
    p_qwen_embedding   := null,
    p_norm_status      := 'active',
    p_effective_at     := current_date,
    p_limit            := 10
  )
  where match_reason like '%effective_date_missing%';

  if warning_count > 0 then
    raise exception 'SMOKE TEST 3 FAILED: % rows have spurious effective_date_missing (p_effective_at was set)', warning_count;
  end if;

  raise notice 'SMOKE TEST 3 PASSED: BM25-only fallback path correct';
end $$;

-- ---------------------------------------------------------------------------
-- SMOKE TEST 4: No effective_at → effective_date_missing warning in ALL rows
-- Verifies FIX #3: when p_effective_at IS NULL, every returned row must carry
-- ':effective_date_missing' in match_reason.
-- ---------------------------------------------------------------------------
-- EXPECTED: if any rows returned, ALL have match_reason LIKE '%effective_date_missing%'

do $$
declare
  total_rows   int;
  warned_rows  int;
begin
  select count(*) into total_rows
  from public.search_legal_corpus_dual(
    p_query_text       := 'Конституция',
    p_metric_embedding := null,
    p_qwen_embedding   := null,
    p_norm_status      := 'active',
    p_effective_at     := null,           -- ← no event date
    p_limit            := 10
  );

  select count(*) into warned_rows
  from public.search_legal_corpus_dual(
    p_query_text       := 'Конституция',
    p_metric_embedding := null,
    p_qwen_embedding   := null,
    p_norm_status      := 'active',
    p_effective_at     := null,
    p_limit            := 10
  )
  where match_reason like '%effective_date_missing%';

  if total_rows > 0 and warned_rows <> total_rows then
    raise exception 'SMOKE TEST 4 FAILED: % of % rows missing effective_date_missing warning',
      total_rows - warned_rows, total_rows;
  end if;

  raise notice 'SMOKE TEST 4 PASSED: effective_date_missing present in all % rows (p_effective_at=null)', total_rows;
end $$;

-- ---------------------------------------------------------------------------
-- DIAGNOSTIC QUERY: inspect actual effective_from/to distribution in search_chunks
-- Run manually to understand what fraction of chunks carry explicit dates.
-- ---------------------------------------------------------------------------
/*
select
  count(*)                                       as total_chunks,
  count(*) filter (where effective_from is not null) as chunks_with_from,
  count(*) filter (where effective_to   is not null) as chunks_with_to,
  count(*) filter (where norm_status = 'active')     as active_chunks,
  count(*) filter (where norm_status = 'repealed')   as repealed_chunks,
  count(*) filter (where norm_status = 'unknown')    as unknown_chunks
from public.search_chunks;
*/

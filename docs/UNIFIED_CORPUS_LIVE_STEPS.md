# Unified Corpus Migration Runbook

Status: local stabilization only. No live Supabase migrations have been applied from this repository state, and generated DB types have not been regenerated.

## Live/local reconciliation status

- Linked live project: `avmgtsonawtzebvazgcr`.
- Do not run `supabase db push` from this repository state: local and live migration histories diverge.
- Local-only migration ranges include legacy target migrations `20260124125739` through `20260510051327`, plus local unified patches `20260605030000`, `20260605040000`, `20260613000000`, and `20260613001000`.
- Live-only migration versions include source/app compatibility and hardening migrations `20260530012000` through `20260530018000`, `20260602000000`, `20260603000000`, `20260603100000`, `20260604000000`, `20260604100000`, `20260604200000`, and `20260610000000`.
- Safe strategy: keep target legacy migrations as local archival history, do not replay them into live, and apply future live changes as explicit manual SQL or carefully reviewed additive migrations after confirming current live objects.
- Docker is required for `supabase db dump --linked`; if Docker is unavailable, use targeted live introspection queries and do not claim a complete schema dump.

## Active retrieval path

- Frontend and edge read/search flow: `search_legal_corpus_dual`, `search_legal_corpus`, `lookup_by_citation`, `lookup_table_rows`.
- Canonical tables: `documents`, `document_versions`, `document_pages`, `search_chunks`, `embeddings`, plus source/reference/internal tables created by the unified corpus migrations.
- Query embedding path: `supabase/functions/embed-query` -> `EMBEDDING_ENDPOINT` -> `scripts/embedding_server.py`.

## Remaining legacy reference classification

- Active runtime gated locally:
  - `src/hooks/useKnowledgeBase.ts`: search uses unified corpus; legacy browse/create/update/delete now returns empty or unsupported.
  - `src/hooks/useKBCategoryCounts.ts`: legacy category browse now returns empty.
  - `src/components/kb/KBCategoryFolder.tsx`: legacy category browse now returns empty.
  - `src/components/kb/KBJsonlImport.tsx`: legacy `knowledge_base` import now fails unsupported.
  - `src/components/kb/KBMultiFileUpload.tsx`: legacy auto-add to `knowledge_base` now fails unsupported.
  - `src/hooks/useBulkImport.ts`: legacy `knowledge_base` / `legal_practice_kb` insert stage now fails unsupported.
  - `src/hooks/useAudioTranscriptions.ts`: legacy add-to-KB now fails unsupported.
  - `src/components/admin/LegalPracticeKB.tsx`: legacy `legal_practice_kb` admin table manager now returns empty or unsupported.
  - `src/components/admin/AdminKnowledgeBaseTab.tsx`: legacy scrape/start actions now fail unsupported; search remains delegated to unified corpus hooks.
  - `src/components/admin/PracticeChunkManager.tsx`: legacy `practice-chunk-enqueue` actions now fail unsupported locally.
  - `src/components/admin/DataSyncToLive.tsx`: legacy `knowledge_base` / `legal_practice_kb` live sync actions now fail unsupported locally.
  - `supabase/functions/ai-analyze/index.ts`: citation ID verification now checks unified `documents.document_id`.
  - `supabase/functions/kb-scrape-batch/index.ts`: legacy scrape-to-`knowledge_base` function now returns HTTP 410.
- Admin/import/write not migrated:
  - Old scripts under `scripts/*.mjs` and older Python loaders still target `knowledge_base` / `legal_practice_kb`. They are not package-script entrypoints for the unified corpus pipeline.
  - Legacy edge functions such as `data-sync-to-live`, `practice-chunk-enqueue`, older import functions, and recovery/backfill functions still exist as repository assets. Do not deploy or schedule them for unified corpus production unless they are separately migrated.
- Docs/comments:
  - Historical docs under `docs/*`, legacy reports, and generated `src/integrations/supabase/types.ts` still mention old tables/RPCs until documentation archival and live type generation are completed.
- Archived/dead assets:
  - Old recovery, OpenAI embedding restore, ARLIS batch, and similarity-test scripts are legacy assets unless a separate operator confirms they are still required.

## Live migration steps

1. Configure the new Supabase project locally:

```sh
supabase login
supabase link --project-ref <new-project-ref>
supabase migration list
```

2. Inspect migration divergence before any live apply:

```sh
supabase migration list
```

Do not run `supabase db push` while local-only legacy migrations and live-only source migrations remain divergent.

3. Regenerate DB types after migrations are applied:

```powershell
supabase gen types typescript --linked --schema public | Set-Content -Encoding utf8 src/integrations/supabase/types.ts
```

4. Set required local/operator env values:

```sh
SUPABASE_URL=https://<new-project-ref>.supabase.co
SUPABASE_ANON_KEY=<new-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<new-service-role-key>
VITE_SUPABASE_URL=https://<new-project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<new-publishable-or-anon-key>
EMBEDDING_MODEL=Metric-AI/armenian-text-embeddings-2-large
EMBEDDING_DB_MODEL=armenian-text-embeddings-2-large
EMBEDDING_DIM=1024
EMBEDDING_BATCH=32
EMBEDDING_ENDPOINT=<reachable-embedding-service-url>
EMBEDDING_API_KEY=<optional-shared-secret>
```

5. Run corpus ingestion in dry-run mode first:

```sh
npm run pipeline:s2
npm run pipeline:s3
npm run pipeline:s4
npm run pipeline:s5
```

6. Run corpus ingestion with writes only after dry-run output is reviewed:

```sh
deno run --allow-read --allow-env --allow-net scripts/ingest_documents_jsonl.ts --input <documents.jsonl> --commit --limit <small-number>
deno run --allow-env --allow-net scripts/normalize_documents.ts --commit --limit <small-number>
deno run --allow-env --allow-net scripts/classify_documents.ts --commit --limit <small-number>
deno run --allow-env --allow-net scripts/chunk_documents.ts --commit --limit <small-number> --domain knowledge_base
```

7. Start and verify the Metric-AI embedding service:

```sh
pip install fastapi uvicorn sentence-transformers
set EMBEDDING_MODEL=Metric-AI/armenian-text-embeddings-2-large
set EMBEDDING_DB_MODEL=armenian-text-embeddings-2-large
uvicorn scripts.embedding_server:app --host 0.0.0.0 --port 8088
```

8. Backfill embeddings only after confirming the provider writes model labels that match the retrieval indexes:

```sql
select model, status, count(*)
from public.embeddings
group by model, status
order by model, status;
```

Expected live retrieval labels include `armenian-text-embeddings-2-large` and, for ECHR/Qwen rows, `qwen3-embedding-0.6b`. The legacy `scripts/embed_chunks.ts --write` Cohere path is blocked unless `LEGACY_COHERE_EMBEDDINGS_CONFIRMED=1` is explicitly set.

Current live `search_legal_corpus_dual` does not use the local-only trigram branch from `20260613000000_fix_search_trigram_and_rpc.sql`, and live does not have `search_chunks_text_trgm_idx`. Active runtime does not require `match_search_chunks`.

9. Smoke test retrieval RPCs:

```sql
select * from public.search_legal_corpus_dual(
  p_query_text := 'contract',
  p_metric_embedding := null,
  p_qwen_embedding := null,
  p_content_domain := 'knowledge_base',
  p_norm_status := 'active',
  p_limit := 5
);

select * from public.search_legal_corpus(
  p_query_text := 'contract',
  p_query_embedding := null,
  p_content_domain := 'knowledge_base',
  p_norm_status := 'active',
  p_effective_at := null,
  p_language_code := null,
  p_limit := 5,
  p_offset := 0
);

select * from public.lookup_by_citation(
  p_citation := '<known-citation>',
  p_limit := 5
);

select * from public.lookup_table_rows(
  p_document_ref := '<known-document-ref>',
  p_table_ref := '<known-table-ref>',
  p_limit := 5
);
```

10. Verify application:

```sh
npx tsc -p tsconfig.app.json --noEmit
npm run build
```

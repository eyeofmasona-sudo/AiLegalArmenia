# iLegal Armenia Remediation Closeout

Date: 2026-06-27 · Project: `avmgtsonawtzebvazgcr` · Scope: close C1/H1/H2/H3 from the final audit.
Changes are minimal-diff. Live DB was inspected and used for validation only — **no production
objects were modified** (the one migration was executed inside a rolled-back transaction).

## 1. Baseline Reconciliation

### Still Confirmed
- **C1** — `EMBEDDING_ENDPOINT=http://127.0.0.1:8088` (`.env:80`) is unreachable from Supabase Edge;
  `vector-search` reads it (`embedMetricQuery`). Silent BM25 fallback by design. Confirmed.
- **H1** — qwen/ECHR query path disabled: `vector-search/index.ts` sent `p_qwen_embedding:null`,
  `p_qwen_limit:0`; live has no qwen ANN index; ~162k qwen ECHR vectors unused at query time. Confirmed.
- **H2** — live secrets present in working-tree `.env` (service-role key, DB password, OpenRouter,
  Gemini, GitHub PAT×2, Vercel token, Supabase access token). Confirmed.
- **Embeddings layer healthy** — `embeddings.vector vector(1024)`, `embeddings_ivf_metric_idx` IVFFlat
  valid + used (EXPLAIN), `ivfflat.probes=10` global. Confirmed (not the root cause).
- **app-schema RLS strong**; prompts RAG-first/anti-injection/anti-hallucination. Confirmed.

### Changed (vs. the audit's first read)
- **H3 is smaller than stated but real.** The live RPC *signature* (10-arg, +`content_domain`
  /+`norm_status`) IS already in repo (`20260613000000_fix_search_trigram_and_rpc.sql`). However the
  live RPC *body* is newer than any migration: it uses materialized ANN CTEs + **RRF** fusion, route
  name `bm25_fts`, and `statement_timeout=15000` — never committed. Index layout also drifted: live is
  **IVFFlat** (`embeddings_ivf_metric_idx`), not the **HNSW** indexes created in `20260605040000`.
- Edge code is compatible with the live route names (`isKeywordRow` matches `bm25_fts`).

### Not Reproducible / Corrected from earlier assumptions
- "probes=1 cripples recall" — **not reproducible**; live `probes=10` (intentional). Downgraded to a
  Medium tuning note in the prior audit; no action here.
- April `EMBEDDINGS_QUALITY_REPORT.md` (OpenAI 1536-dim) remains **stale**; live is 1024-dim.

## 2. Findings Addressed

| ID | Sev | Status | Evidence | Fix |
|----|-----|--------|----------|-----|
| C1 | Critical | **Code fixed / Awaiting operator action** | `vector-search/index.ts` `embedMetricQuery`; `embed-query/index.ts`; `.env:80` | Added `isUnroutableEndpoint()` loud warning in `vector-search`; `embed-query` returns `embedding_endpoint_unroutable` 503; `.env.example` + `docs/VPS_EMBEDDINGS_DEPLOYMENT.md` document the public-HTTPS requirement. Operator must set the public endpoint in Edge Secrets. |
| H1 | High | **Resolved (Option B) / future-enable documented** | `vector-search/index.ts:74-90`, live: no qwen index | qwen arm formally disabled with an honest comment (not dead code); telemetry now reports `qwen_semantic_ok:false` + `QWEN_QUERY_EMBEDDING_DISABLED`; enable path (qwen query endpoint + partial index) documented in code and VPS doc. |
| H2 | High | **Code fixed / Awaiting operator rotation** | `.gitignore`, `docs/SECURITY_SECRET_ROTATION.md` | `.gitignore` now ignores `.env.*` while keeping `*.example`; provider-by-provider rotation checklist + leak-scan commands added; repo/doc files verified secret-free (grep clean). Actual rotation is owner action. |
| H3 | High | **Resolved (repo now reproduces prod)** | `supabase/migrations/20260627030000_…sql`, `live_schema_public.sql` | New baseline migration captures the exact live dual RPC (RRF body) + reconciles indexes (drop HNSW, ensure IVFFlat). Validated by executing against live in a rolled-back transaction. Empty `live_schema_public.sql` replaced with a regeneration pointer. |

### Why H1 chose Option B (formal disable) over Option A (restore)
Option A (live dual-query) needs (1) a running **qwen3-embedding-0.6b** query service — no endpoint
exists — and (2) a qwen ANN index — none in prod (so the arm would seq-scan 162k vectors and add
latency). Both are external dependencies/decisions. Per the rules (correctness + min risk + min diff +
production clarity), the path is to make the disabled state **honest and explicit** now, and document
the exact steps to enable later. The code no longer pretends the path works; telemetry says it's off.

**H1 clamp guardrail (captured in the H3 migration):** inside the RPC, `p_qwen_limit` is clamped to
≥1 (`least(greatest(coalesce(p_qwen_limit,30),1),100)`), so `p_qwen_limit=0` is **not** an off-switch.
The only real gate is `p_qwen_embedding IS NULL`. All 7 callsites pass `p_qwen_embedding:null`, so the
arm never runs — but a future non-null qwen embedding (before the qwen ANN index exists) would seq-scan
~162k vectors. This is documented in `20260627030000_baseline_live_dual_rpc_and_indexes.sql`.

## 3. Validation Performed
- Regex `isUnroutableEndpoint` unit-checked (Node): matches `127.0.0.1`/`10.x`/`192.168.x`, not public
  domains.
- Baseline migration **executed against live inside a transaction, then ROLLED BACK** → parses and is
  schema-valid; production unchanged.
- Secret scan across `*.md/*.ts/*.sql/*.example` (excl. `.env`) → clean.
- Structural review of edited `vector-search`/`embed-query` regions → coherent.
- `deno check` not run (deno not installable in this sandbox within timeout); edits are localized,
  type-annotated (`qwenEmbedding: number[] | null` prevents literal-null narrowing), and reviewed.

## 4. Files Changed (this session)
- `supabase/functions/vector-search/index.ts` — unroutable-endpoint warning; qwen arm honest-disabled; qwen telemetry.
- `supabase/functions/embed-query/index.ts` — explicit `embedding_endpoint_unroutable` guard.
- `.env.example` — public-HTTPS endpoint guidance (from prior session, retained).
- `.gitignore` — ignore `.env.*`, keep `*.example`.
- `docs/SECURITY_SECRET_ROTATION.md` — new (H2 checklist).
- `docs/VPS_EMBEDDINGS_DEPLOYMENT.md` — runbook (from prior session, retained).
- `supabase/migrations/20260627030000_baseline_live_dual_rpc_and_indexes.sql` — new (H3 baseline).
- `live_schema_public.sql` — regeneration pointer (was 0 bytes).

## 5. Repair Prompt Blocks (for the remaining operator/optional work)

### Repair Prompt: C1 — set public endpoint (operator)
```text
In Supabase Dashboard -> Edge Functions -> Secrets set:
  EMBEDDING_ENDPOINT = https://<vps-domain>     (NOT 127.0.0.1)
  EMBEDDING_API_KEY  = <same secret as the VPS embedding server>
Then run an AI search and confirm vector-search returns retrieval_mode "vector"/"hybrid" and
semantic_ok=true (not keyword_only/rpc_fallback). Stand up the VPS server per
docs/VPS_EMBEDDINGS_DEPLOYMENT.md first. No code change required.
```

### Repair Prompt: H1 — enable ECHR semantic later (optional)
```text
Goal: turn on the qwen/ECHR arm. Minimal diff; do not touch the Armenian metric path.
1. Stand up a query-embedding service for qwen3-embedding-0.6b (1024-dim) reachable from Edge.
2. In supabase/functions/vector-search/index.ts add embedQwenQuery() (mirror embedMetricQuery,
   reading QWEN_EMBEDDING_ENDPOINT/QWEN_EMBEDDING_API_KEY) and set
   `const qwenEmbedding = await embedQwenQuery(query, requestId);`
3. Add partial index: create index embeddings_ivf_qwen_idx on public.embeddings
   using ivfflat (vector vector_cosine_ops) with (lists=200)
   where model='qwen3-embedding-0.6b' and status='success';
4. Validate: an ECHR query returns rows with retrieval_route='qwen_echr' (not only bm25_fts).
Alternative (simpler ops): re-embed the 162k ECHR chunks with the Armenian model and drop qwen rows;
then the existing metric index/path covers ECHR and no second server is needed.
Return only: files changed, actions performed, remaining blockers.
```

### Repair Prompt: H2 — rotate secrets (operator)
```text
Follow docs/SECURITY_SECRET_ROTATION.md: revoke+reissue Supabase service-role/anon keys, DB password,
SUPABASE_ACCESS_TOKEN, OpenRouter, Gemini, GitHub PAT(s), Vercel token, Telegram tokens, and regenerate
INTERNAL_INGEST_KEY/CRON_WORKER_KEY. Move all to Edge Secrets / server env / CI store. Then run the
leak-scan commands in that doc and confirm `git ls-files | grep '^\.env'` (excl. example) is empty.
```

### Repair Prompt: H3 — apply baseline to fresh envs
```text
The live dual RPC + index state is now in
supabase/migrations/20260627030000_baseline_live_dual_rpc_and_indexes.sql. It is already live in
production (do NOT re-run there). For any NEW/branch DB, `supabase db reset` will reproduce it.
Optionally regenerate the full schema dump per the header of live_schema_public.sql.
```

## 6. Production / VPS Readiness — final status
| Item | Status |
|------|--------|
| C1 embedding endpoint | Code-explicit; **operator must set public endpoint + run VPS server** |
| H1 ECHR semantic | Honestly disabled + documented; optional enable path provided |
| H2 secrets | Hardened; **operator rotation required** |
| H3 migration drift | Reconciled in repo; validated against live |
| Armenian semantic path | Works once C1 endpoint is public |
| RLS / prompts / embeddings data | Verified good — no action |

**Net:** all four Critical/High items are code/config-closed. Two require owner action that cannot be
done from here (set the public endpoint + secret rotation) — both have exact checklists. ECHR semantic
search is intentionally off until a qwen query path is added (documented).

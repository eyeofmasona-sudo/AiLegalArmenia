# iLegal Armenia — Final Audit (2026-06-27)

Auditor session: end-to-end audit against **live** project `avmgtsonawtzebvazgcr` (read via session
pooler) + full source tree. Evidence is cited as file:line, table/index/RPC names, or live query output.

## 1. Executive Summary

- **Overall status:** Solid, mature system. Architecture, RLS, prompts, and the embedding *data* are
  in good shape. The defects are concentrated in **deployment wiring** and **one disabled retrieval
  path**, plus secret hygiene — not in the core code.
- **Production-ready?** Backend/DB/security: **yes, with caveats** (rotate secrets, reconcile migration
  drift). Frontend: representative pass only — no blockers found.
- **Embeddings/RAG deployment-ready?** **Conditionally.** The Armenian semantic path is correct and the
  index is healthy, but it only works once a **public** `EMBEDDING_ENDPOINT` points at the VPS embedding
  server. The current `127.0.0.1` value is unreachable from Supabase edge → silent BM25 fallback. ECHR
  (qwen3) semantic search is currently disabled in code.
- **Top risks:** (C1) localhost embedding endpoint → semantic search silently off; (H1) ECHR/qwen vector
  path dead; (H2) live secrets in working-tree `.env`; (H3) migration↔production drift.

## 2. System Map

- **Frontend:** Vite + React 18 + TypeScript + shadcn/Radix + Tailwind, TanStack Query, react-router,
  i18next (hy/ru/en), PWA. `src/` (pages, components, hooks, integrations).
- **Backend:** 52 Supabase Edge Functions (Deno) under `supabase/functions/`. Shared libs in `_shared/`
  (`rag-search.ts`, `edge-security.ts`, `prompt-armor.ts`, model registry, safe-logger, ai-metrics).
- **AI providers:** OpenRouter (primary) → OpenAI → Gemini fallback (`.env`, README). Per-function model
  overrides via `OPENROUTER_MODEL_*`.
- **DB (live):** Postgres + `vector 0.8.0`, `pg_trgm`, `pgcrypto`, `supabase_vault`. Schemas: `public`
  (legal corpus), `app` (client/case data), `internal` (pipeline). ~1.49M `search_chunks`, ~1.50M
  `embeddings`, 218k `documents`.
- **RAG flow:** UI → AI edge fn → `_shared/rag-search.ts` → `vector-search` edge fn → `embed-query`-style
  call to **VPS embedding server** for the query vector → `search_legal_corpus_dual` RPC (metric ANN +
  qwen ANN + BM25, fused/deduped) → context → LLM.
- **Embedding model:** `Metric-AI/armenian-text-embeddings-2-large` (1024-dim, cosine) self-hosted via
  `scripts/embedding_server.py` (FastAPI) + `embeddings_provider.py` (sentence-transformers).
- **Deploy:** Frontend → Vercel (token in `.env`). DB/functions → Supabase. Embedding model → **VPS**
  (being provisioned). See `docs/VPS_EMBEDDINGS_DEPLOYMENT.md`.

## 3. Verified / Inference / Assumption / Unknown

### Verified (live evidence)
- `embeddings.vector` is `vector(1024)`; index `embeddings_ivf_metric_idx` = IVFFlat `lists=900`,
  partial `WHERE model='armenian-text-embeddings-2-large' AND status='success'`, `indisvalid=true`,
  and **used** (EXPLAIN: `Index Scan using embeddings_ivf_metric_idx`).
- Two models coexist, **all `status='success'`**: `armenian-text-embeddings-2-large` = 1,327,574;
  `qwen3-embedding-0.6b` = 162,206. Both 1024-dim. No NULL/error rows.
- `ivfflat.probes = 10` globally (not the default 1).
- RLS enabled on all `public`, `app`, `internal` base tables. `app` schema enforces real per-case
  isolation: `cases_select USING app.can_read_case(case_id)`, `is_case_lawyer()`, admin role checks.
  Permissive `ALL true` policies are scoped to **`service_role` only** (bypasses RLS anyway → harmless).
- `vector-search/index.ts:73-74` passes `p_qwen_embedding:null`, `p_qwen_limit:0`. No qwen ANN index
  exists in production.
- Live RPC `search_legal_corpus_dual` signature includes `p_content_domain`, `p_norm_status` (10 args);
  repo migration `20260605040000` defines an 8-arg version and creates **HNSW** indexes — production has
  **IVFFlat** instead. Migration↔prod drift confirmed. `live_schema_public.sql` is 0 bytes.
- System prompt (`ai-analyze/system.ts`) enforces RAG-first, `ANTI_INJECTION_RULES`, absolute
  no-hallucination, structured `[PRACTICE]` citation rules, role modes, norm hierarchy.

### Inference
- Sum of model counts (≈1.49M) ≈ total chunks ⇒ the two models partition the corpus near-**disjointly**;
  ECHR (en/fr) chunks live in qwen space, Armenian (hy) in metric space.
- Because the query side never produces a qwen vector and there's no qwen index, **ECHR semantic search
  is effectively keyword-only today.**
- `probes=10` is set via `ALTER SYSTEM` (no role/db-level row found) — intentional global tuning.

### Assumption
- `public.court_cases` / `parties` (readable by any authenticated user) hold **public case-law**
  metadata, not private client PII (client data is in `app.*`). Needs a one-line confirmation.
- The April `EMBEDDINGS_QUALITY_REPORT.md` (OpenAI 1536-dim) is **stale**; superseded by the 1024-dim
  corpus migration. Live data confirms 1024.

### Unknown / not deep-audited
- Per-function deep review of all 52 edge functions (priority RAG path audited; others representative).
- Full UI/UX walkthrough (representative pass only; no live frontend run).
- Whether `app`/`internal` schemas are exposed via PostgREST `db-schemas` (verify they're not).
- `with_check` clauses on `app.*` INSERT policies (owner-spoofing check).

## 4. Findings by Domain

### Architecture — strong
Clean separation: `public` corpus / `app` tenant data / `internal` pipeline; provider abstraction;
graceful BM25 degradation; shared RAG module. No structural blockers.

### Functions & Integrations
- **F-1 (Med):** `_shared/rag-search.ts` keyword & case-number branches are stubbed
  (`keywordPromise = Promise.resolve([])`, `caseNumberPromise = …`, unused `safeKeywords`,
  lines ~270, 354-355). The real FTS fallback lives in the RPC (`p_bm25_limit`), so behavior is fine,
  but the dead code + "falls back to FTS" comments are misleading. *Leave code as-is (working); document.*
- **F-2 (Low):** `embed-query` and `vector-search` correctly guard dimension (`length===1024`) and
  timeout (20s) — good.

### Supabase / DB
- **S-1 (High, H3):** migration↔production drift (RPC arity, IVFFlat vs HNSW indexes, empty
  `live_schema_public.sql`). A rebuild from `supabase/migrations` would **not** reproduce prod.
- **S-2 (Med):** duplicate tables across schemas — `public.cases` vs `app.cases`,
  `public.generated_documents` vs `app.generated_documents`. Identify canonical, drop/lock the other.
- **S-3 (Med):** confirm `internal` schema (`source_files`, `ingestion_jobs`, `extraction_runs`,
  `ai_metrics`) is **not** PostgREST-exposed (service-role only).
- **S-4 (Low):** ~30 redundant `ALL true` `service_role` policies — harmless, optional cleanup.

### Embeddings / Chunking / RAG  (priority)
- **C1 (Critical):** `EMBEDDING_ENDPOINT=http://127.0.0.1:8088` (`.env:80`). Edge functions
  (`vector-search/index.ts:185`, `embed-query/index.ts:51`) run on Supabase and cannot reach the VPS
  localhost → `metricEmbedding=null` → **all semantic search silently degrades to BM25.** Fix = public
  HTTPS endpoint in Edge Secrets. See `docs/VPS_EMBEDDINGS_DEPLOYMENT.md`. Evidence-backed.
- **H1 (High):** ECHR/qwen semantic path dead — `p_qwen_embedding:null`, `p_qwen_limit:0`
  (`vector-search/index.ts:73-74`), no qwen ANN index. 162,206 ECHR chunks reachable by BM25 only.
  Fix options in the VPS doc (run qwen server **or** re-embed ECHR with the Armenian model).
- **M-1 (Med):** IVFFlat `lists=900` for 1.33M rows is on the low side; `probes=10` is OK but for a
  legal-recall product consider `probes 16–24`, or rebuild `lists≈1150`, or adopt HNSW (which the repo
  migration originally intended). Tuning, not a bug — index is valid and used.
- **Strength:** chunking carries rich metadata (`token_count`, `page_from/to`, `char_start/end`,
  `language_code`, `content_domain`, `effective_from/to`, `citation_anchor`, `chunk_text_sha256`),
  enabling temporal filtering and source traceability. Embeddings normalized, 100% success.

### Prompt Quality — strong
`ai-analyze/system.ts` (v3) + 30+ role/task prompt files. RAG-first, `ANTI_INJECTION_RULES`, absolute
no-hallucination, strict `[PRACTICE]` citation grammar, norm hierarchy, temporal disclaimers
(`temporalDisclaimer()`), role modes. Recommendation **P-1 (Med):** wire the existing `eval-runner` /
`run_rag_eval.ts` into CI so retrieval regressions like H1 are caught automatically.

### UI / UX — representative pass
`KBSearchPanel.tsx` does "unified search via edge function (with fallback)"; hooks have client-side
fallbacks. **UX-1 (Med):** because semantic→BM25 degradation is silent, the UI can present BM25 results
as if semantic search succeeded. Surface `retrieval_mode`/`semantic_ok` (already returned by
`vector-search`) as a subtle indicator/admin signal so operators see when embeddings are down.

### Security — strong
- RLS correct and enforced (see §3). `app` per-case isolation is well-designed.
- **SEC-1 (High, H2):** `.env` (working tree) contains **live** `SUPABASE_SERVICE_ROLE_KEY`, DB password,
  `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `VERCEL_TOKEN`. Gitignored, but
  the service-role key + DB password grant full DB access and several tokens are unrelated to the app.
  **Rotate** any key that may have left the machine; confirm `.env` is absent from git history; move
  edge secrets to the Supabase dashboard only.
- **SEC-2 (Low):** confirm `court_cases`/`parties` hold only public case-law (assumption in §3).
- **SEC-3 (Low):** verify `with_check` on `app.*` INSERT policies prevents owner spoofing.

### Performance / Cost
Indexing healthy (GIN FTS, btree, IVFFlat). Edge calls bounded (timeouts, statement_timeout 8s, query
clamp 2000, result caps). No N+1 observed in the RAG path. `pg_stat_statements` enabled — usable for
slow-query review.

### VPS / Deployment
Covered in full in `docs/VPS_EMBEDDINGS_DEPLOYMENT.md`: services to run (embedding server + reverse
proxy), systemd unit, Nginx TLS, secrets, health/E2E checks, failure modes, and the ECHR/qwen gap.

## 5. Priority Repair Queue
1. **C1** — set public HTTPS `EMBEDDING_ENDPOINT` (+ API key) in Supabase Edge Secrets; stand up the VPS
   embedding server. *(config/deploy — code is correct)*
2. **H2 / SEC-1** — rotate exposed secrets; verify `.env` not in git history.
3. **H1** — decide ECHR strategy (run qwen server **or** re-embed ECHR with Armenian model) and wire it.
4. **H3 / S-1** — dump live schema into `supabase/migrations` (or a baseline) so prod is reproducible.
5. **M-1** — tune IVFFlat (`probes`/`lists`) or move to HNSW; **P-1** — add eval gate in CI.
6. **S-2/S-3, UX-1, F-1** — schema-duplicate cleanup, hide `internal` from PostgREST, surface
   `retrieval_mode`, prune misleading dead code/comments.

## 6. Repair Prompt Blocks

### Repair Prompt: C1 — public embedding endpoint
```text
Context: Supabase edge functions vector-search and embed-query read EMBEDDING_ENDPOINT to fetch the
query vector from scripts/embedding_server.py. In production this must be a PUBLIC https URL (the VPS),
not 127.0.0.1. Do NOT change any .ts code (it is correct). Minimal diff only.
Tasks:
1. Confirm docs/VPS_EMBEDDINGS_DEPLOYMENT.md is accurate for this environment.
2. In Supabase Dashboard -> Edge Functions -> Secrets set EMBEDDING_ENDPOINT=https://<vps-domain> and
   EMBEDDING_API_KEY=<secret>. (Manual — out of repo.)
3. Add a one-line note in README pointing to docs/VPS_EMBEDDINGS_DEPLOYMENT.md.
Validate: curl https://<domain>/health -> dimension 1024; run a search and confirm vector-search returns
retrieval_mode "vector"/"hybrid" and semantic_ok=true.
Return only: files changed, actions performed, remaining blockers.
```

### Repair Prompt: H1 — ECHR/qwen semantic path
```text
Context: search_legal_corpus_dual supports a qwen ECHR arm, but vector-search/index.ts hardcodes
p_qwen_embedding:null and p_qwen_limit:0, and prod has no qwen ANN index. 162,206 ECHR chunks are
BM25-only. Decide ONE path; minimal diff; do not touch the Armenian metric path.
Option A (recommended): re-embed ECHR chunks (model='qwen3-embedding-0.6b', canonical_key like 'echr:%')
with armenian-text-embeddings-2-large so the existing metric index/path covers them; then drop qwen rows.
Option B: stand up a qwen query-embedding endpoint, set p_qwen_embedding/p_qwen_limit>0 in vector-search,
and create a partial ANN index WHERE model='qwen3-embedding-0.6b' AND status='success'.
Validate: ECHR query returns rows with retrieval_route in ('metric_hy' for A | 'qwen_echr' for B), not
only 'bm25'. Requires the embedding server running (external blocker until VPS is up).
Return only: files changed, actions performed, remaining blockers.
```

### Repair Prompt: H3 — migration/prod drift
```text
Context: live RPC search_legal_corpus_dual (10-arg, +content_domain/+norm_status) and IVFFlat index
differ from repo migrations (8-arg, HNSW). live_schema_public.sql is empty. Make migrations reproduce prod.
Tasks: dump live public/app/internal schema + the live RPC definition; add a baseline migration that
matches production exactly; do not alter live objects. Keep diffs additive.
Validate: a fresh `supabase db reset` produces the live RPC arity and the embeddings_ivf_metric_idx.
Return only: files changed, actions performed, remaining blockers.
```

## 7. Final Closeout

**Fixes applied this session (minimal diff):**
- `.env.example` — documented that `EMBEDDING_ENDPOINT` must be a public HTTPS URL set in Edge Secrets
  (the C1 trap); clarified `EMBEDDING_API_KEY` shared-secret usage.
- `docs/VPS_EMBEDDINGS_DEPLOYMENT.md` — created: exact services, systemd, Nginx, secrets, E2E verify,
  failure modes, ECHR gap.
- Live DB: applied then **reverted** a no-op `ALTER DATABASE … ivfflat.probes` (was shadowed by the
  global `probes=10`); production left exactly as found. **No destructive live changes made.**

**Remaining Medium/Low:** F-1 dead code, S-2 schema duplicates, S-3 internal-schema exposure check,
M-1 ANN tuning, P-1 eval-in-CI, UX-1 retrieval-mode surfacing, SEC-2/3 confirmations.

**External blockers (need user action):**
- C1/H1 require the VPS embedding server running + a public domain/cert + Supabase Edge Secrets.
- H2 secret rotation is the user's to perform.
- H3 schema baseline can be done now but is best run with `supabase` CLI access.

**VPS embeddings checklist:** see `docs/VPS_EMBEDDINGS_DEPLOYMENT.md` §"What must run on the VPS".

**Confidence by domain:** Architecture High · Supabase/RLS High · Embeddings data High · RAG wiring High
(two concrete defects, both diagnosed) · Prompts High · Security High (pending secret rotation) ·
Functions Medium (priority path deep, others representative) · UI/UX Medium (representative).

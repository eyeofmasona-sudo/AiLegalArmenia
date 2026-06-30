# AI LEGAL ARMENIA — Final Architectural Production Audit

**Date:** 2026-06-29
**Scope:** whole system as a professional legal expert platform (not code-review / not security).
**Method:** verified against current source. Every verdict cites code. Prior reports NOT trusted.
**Legend:** PASS / PARTIAL / FAIL.

---

## STAGE 1. Architecture (request path)

```
React SPA (hooks) -> Supabase Edge Functions (Deno) -> Postgres + pgvector
                                                         RPC search_legal_corpus_dual (BM25+dense, RRF)
Per request on every "answer" surface (legal-chat / ai-analyze / multi-agent / generate-document / generate-complaint):
  1. runLegalReasoningEngine()        -> legal_reasoning (facts/issues/domain/stage/retrieval_plan, heuristic)
  2. buildReasoningSearchQuery()      -> query
  3. dualSearch()/searchKB+Practice   -> vector-search -> RPC (RRF)   [+ source_hierarchy + court_practice computed in rag-search]
  4. legal_reasoning.source_hierarchy = buildSourceHierarchyContext()  (incl lex_specialis/posterior)
     legal_reasoning.court_practice   = buildCourtPracticeContext()
     legal_reasoning.temporal_validation = buildTemporalContextForPrompt()
  5. legalReasoningContext = buildLegalReasoningContext()   -> JSON.stringify(whole engine) injected into prompt
  6. system prompt = buildLegalCorePrompt() + role/jurisdiction prompts
  7. LLM call (openai-router) -> single completion (chat streams)
  8. verifyCitationsInText() post-generation (+ PRECEDENT GUARD in complaint; grounding gate in multi-agent)
```

Shared engine layer (`_shared/`): legal-core-prompt (135), legal-reasoning-engine (451), citation-verifier (588), source-hierarchy-engine (376), temporal-validity-engine (180), court-practice-engine (605), multi-agent-grounding (400), rag-search (735). All reused across surfaces — genuinely modular.

---

## STAGE 2. Engines

| Engine | Verdict | Evidence / gap |
|---|---|---|
| **Legal Core** | PASS | `buildLegalCorePrompt` imported & used by all 5 surfaces. NOTE: legal-chat additionally concatenates a legacy inline `LEGAL_AI_SYSTEM_PROMPT` (legal-chat:24, used at :416-421) — duplicated methodology layer. |
| **Legal Reasoning Engine** | PARTIAL | `runLegalReasoningEngine` used everywhere; produces facts/issues/domain/stage/retrieval_plan/checklist. BUT it is a **deterministic regex/heuristic planner** (issue-spotting via regex, legal-reasoning-engine.ts matches()/classifyDomains()), not adjudicative reasoning. It builds context; it does not reason. No multi-step orchestration. |
| **Citation Verification** | PASS | `verifyCitationsInText` (citation-verifier.ts) now does L1 existence + L2 chunk + L3 quote-in-chunk + article/category/temporal checks, risk levels, forbidden-certainty phrases. Used in all 5 surfaces. Caveat: legal-chat verifies **after** streaming (legal-chat:562) -> annotate-only, cannot block already-sent tokens. |
| **Multi-Agent Grounding** | PASS (with caveat) | `runPreAnalysisGrounding` gate + `INSUFFICIENT_LEGAL_GROUNDING` stop + `findCitationsOutsideGrounding` enforcement in all 3 modes (multi-agent-analyze:767/828/898/960/1086/1190). Orchestration still client-driven across agents. |
| **Source Hierarchy** | PASS | `buildSourceHierarchyContext` ranks by authority (constitution>treaty>echr>CC>cassation>code>...>lower court>venice) and runs lex_specialis/posterior; reaches prompt via legal_reasoning. |
| **Temporal Validity** | PARTIAL | Engine used across surfaces; RPC all-branch effective-date fix exists (migration 20260628120000) **but pending production apply + smoke tests** (per remediation memory). Until applied, BM25 fallback path in prod still leaks revisions. |
| **Court Practice Engine** | PARTIAL | classify/rank/conflicts computed and injected into prompt (see Stage 7). BUT `validatePracticeUse`, `detectCassationPosition`, `detectConstitutionalCourtPosition` are **defined and tested but never called** in any surface -> no enforcement of "validated practice only" (Rule 10). `supports_user/opposing_position` are pass-through (engine cannot derive them). |
| **Lex Specialis** | PARTIAL | Called inside `buildSourceHierarchyContext` (source-hierarchy-engine.ts:359); result reaches prompt. But it is heuristic (text-based special/general detection), not a verified rule resolver. |
| **Lex Posterior** | PARTIAL | Same: called at source-hierarchy-engine.ts:360 over `temporal_context`; heuristic. |

---

## STAGE 3. Integration

- Single Legal Core: PARTIAL — `buildLegalCorePrompt` everywhere, but legal-chat also appends legacy `LEGAL_AI_SYSTEM_PROMPT`.
- Legal Reasoning used uniformly: PASS — same `runLegalReasoningEngine` + `buildLegalReasoningContext` in all surfaces (multi-agent via grounding).
- One RAG path: PASS — all go through `dualSearch`/`searchKB`+`searchPractice` -> `vector-search` -> RPC. No surface queries the corpus by another route.
- One Citation path: PASS — all use `verifyCitationsInText`; complaint adds an extra PRECEDENT GUARD (allowlist) on top (defensible, not a bypass).
- Architecture bypasses: none found. No surface calls the LLM without core+reasoning+RAG context.

---

## STAGE 4. Prompt System

- Unified methodology: PARTIAL — Legal Core unifies the base; role/jurisdiction prompts layer on top (by design); legal-chat's legacy inline prompt is redundant duplication.
- Conflicting instructions: low risk; the legacy + core layers are complementary but overlap.
- Removable: legacy `LEGAL_AI_SYSTEM_PROMPT` in legal-chat is a candidate; doc-set `ALL_PROMPTS.md`/`SYSTEM_PROMPTS*.md` duplicate code prompts (drift risk).
- Engine->prompt delivery is a raw `JSON.stringify(engine, null, 2)` dump (legal-reasoning-engine buildLegalReasoningContext) — token-heavy and not curated for model adherence.

---

## STAGE 5. Retrieval

- BM25: PASS (RPC bm25_candidates, ts_rank_cd). Dense: PASS (metric_hy, IVFFlat). Hybrid+RRF: PASS (RPC fuses, RRF 1/(60+rank)).
- rerank: FAIL — `rerank_ok` is just an alias of `semanticOk` (vector-search:136); no actual reranker.
- ECHR retrieval: PARTIAL — qwen/ECHR semantic hard-disabled (`qwenEmbedding=null`, p_qwen_limit=0); ECHR served by BM25 only.
- ARLIS retrieval: PASS (source typing 'arlis' in RPC). Court retrieval: PASS (content_domain='practice'). Municipal: PARTIAL — query class exists in reasoning plan, but corpus source-typing does not distinguish mayor/council acts.
- Single system? PASS structurally (one RPC), but semantic depth depends on an external `EMBEDDING_ENDPOINT`; if misconfigured it silently degrades to BM25. Dead keyword/case-number branches remain in rag-search (lines 284/371/372 `Promise.resolve([])`).

**Verdict: retrieval is one system, but operating below capacity (no rerank, ECHR semantic off, exact-match branches dead).**

---

## STAGE 6. Legal methodology coverage

Present & in-context: facts (heuristic), issue-spotting (heuristic), legal domain, procedural stage, temporal validity, hierarchy, lex specialis/posterior (heuristic), court practice, ECHR/CC/Cassation classification. Via agents/prompts: evidence, party arguments, counterarguments, risks, reasoned conclusion.
Weak/absent as enforced logic: true fact/issue adjudication (regex only), enforced practice-validity, verified (non-heuristic) lex resolution, model-independent reasoned conclusion. The methodology is **assembled as context for one LLM call**, not executed as a reasoning machine.

---

## STAGE 7. Court Practice — is it actually used?

- Computed: YES (buildCourtPracticeContext in rag-search, legal-chat:408, ai-analyze:829, multi-agent-grounding, generate-*).
- In prompt context: **YES** — `legalReasoningContext` is rebuilt AFTER court_practice is set (legal-chat:414, ai-analyze:838, generate-document:175, generate-complaint:174) and injected (legal-chat:420, ai-analyze:1004, generate-document:286, generate-complaint:305); `buildLegalReasoningContext` JSON-dumps the whole engine incl `court_practice`.
- Enforcement / used by model at reasoning: **PARTIAL** — it arrives as part of a raw JSON blob; nothing constrains the model to it, and `validatePracticeUse` (the gate) is never called. detect* position helpers unused.

**Verdict: better than "metadata only" (it is in the prompt), but PARTIAL — classified and delivered, not enforced.**

---

## STAGE 8. Architecture quality

Modularity PASS (clean shared engines). Reuse PASS (5 surfaces share the layer). Separation of concerns PASS. Pluggability PASS (adding an engine = add field to legal_reasoning + wire). Coupling: MEDIUM — `buildLegalReasoningContext` couples all engines into one JSON blob and every surface repeats the same enrich-then-rebuild sequence (copy-paste integration, not an orchestrator). Maintainability PARTIAL — duplicated wiring + legacy prompt + dead branches.

---

## STAGE 9. Performance

- Repeated reasoning: `buildLegalReasoningContext` is built twice per request (once early, once after enrichment) — cheap but wasteful.
- Repeated classification: `buildCourtPracticeContext` calls `rankCourtPractice` AND `detectPracticeConflicts`, each of which calls `classifyCourtPractice` on every practice -> each practice classified ~3x per request (court-practice-engine). CPU-only, small N (<=5), minor.
- DB: retrieval is single-RPC; no duplicate retrieval found. Citation verification = 1 pass per surface (chat post-stream). No duplicate DB round-trips found beyond citation existence + temporal lookups.
- Token cost: full-engine `JSON.stringify` injected into every prompt is the main inefficiency.

---

## STAGE 10. Legal reliability risk

- Wrong norm: MEDIUM (retrieval recall limited; no rerank).
- Wrong revision: MEDIUM-HIGH until temporal migration applied in prod; LOW-MEDIUM after.
- Weak practice misuse: MEDIUM — engine classifies weight but does not enforce it (validatePracticeUse unused).
- False citation: LOW-MEDIUM — strong post-hoc verifier; but chat verifies after streaming (cannot retract).
- Wrong hierarchy: LOW-MEDIUM — hierarchy computed; delivered as JSON, not enforced.
- Hallucination: LOW-MEDIUM — grounding gate (multi-agent) + citation verifier reduce it; chat weakest (annotate-only).
- Wrong argumentation: MEDIUM — depends on single LLM call adhering to JSON context.

---

## STAGE 11. Production Readiness Score (0-100)

| Area | Score |
|---|---|
| Architecture | 80 |
| Legal AI (methodology depth) | 60 |
| RAG | 65 |
| Retrieval | 62 |
| Citation | 78 |
| Temporal | 72 (code) / pending prod apply |
| Hierarchy | 75 |
| Court Practice | 55 |
| Prompt System | 65 |
| Multi-Agent | 70 |
| Document generation | 72 |
| Scalability | 78 |
| Performance | 62 |
| **Overall (weighted, legal-critical)** | **~66 / 100** |

---

## STAGE 12. Missing architectural capabilities (most important)

1. **True legal reasoning orchestration** — Critical / High impact / High effort. Today: one LLM call per surface fed a context blob. No iterative intake->clarify->issue->apply->counterargue->conclude state machine. This is the single biggest gap to "expert system".
2. **Court-practice enforcement layer** — High / High / Low. `validatePracticeUse` exists but is never invoked; weak/outdated/non-court practice is not filtered before prompting.
3. **Clarification loop (missing-facts gate)** — High / Medium / Medium. Engine flags missing facts but never pauses to ask; it proceeds to answer.
4. **Live ECHR semantic + reranking** — Medium-High / High / Medium. qwen arm + rerank are designed-for but off; ECHR is BM25-only.
5. **Curated engine->prompt serialization** — Medium / High adherence impact / Low-Medium. Replace raw JSON dump with a structured NL brief of binding sources, controlling practice, temporal caution.
6. **Server-side multi-agent orchestrator** — Medium / Medium / Medium. Sequencing is client+DB driven, not a server pipeline.

---

## STAGE 13. Removable / dead / duplicated

- Dead retrieval branches: `keywordPromise`/`caseNumberPromise = Promise.resolve([])` (rag-search.ts:284/371/372) — either delete or re-enable for exact case-number recall.
- Legacy inline prompt: `LEGAL_AI_SYSTEM_PROMPT` in legal-chat (redundant with Legal Core).
- Unused engine exports: `validatePracticeUse`, `detectCassationPosition`, `detectConstitutionalCourtPosition` (court-practice-engine) — only referenced in tests.
- Doc duplication: `ALL_PROMPTS.md`, `SYSTEM_PROMPTS*.md`, `src/data/initialPrompts.ts` duplicate code prompts (drift risk; generate from code).
- Stale reports in repo root (e.g., 1536-dim embeddings report) already flagged.

---

## STAGE 14. Final verdict

**1. Is AI Legal Armenia a professional legal expert system?**
Not yet — but it is now a **grounded legal RAG with a deterministic legal-context planner**, materially beyond a plain RAG chat. It has real hybrid retrieval, an enforced citation-grounding layer, source hierarchy with lex rules, temporal validity, and court-practice classification delivered into the prompt. What keeps it short of "expert system" is that all of this is **assembled as context for a single LLM completion** rather than executed as a reasoning/decision engine, and key safeguards are computed but not enforced.

**2. What is missing (concretely):**
- a real reasoning/orchestration pipeline (currently single-shot per surface);
- enforcement of court-practice validity (validatePracticeUse unused);
- a clarification/missing-facts gate;
- live ECHR semantic retrieval + reranking;
- curated (non-JSON-dump) delivery of engine outputs to the model;
- temporal fix applied in production.

**3. Highest-impact final improvements (if pursuing "expert system"):**
introduce a server-side reasoning orchestrator that consumes the engines step-by-step and enforces their verdicts (hierarchy, temporal, practice-validity) before and after generation.

**4. Top 3 — maximum effect, minimum change:**
1. **Enforce Court Practice**: call `validatePracticeUse` and drop weak/outdated/non-court practice before prompt injection (engine already exists; Court Practice PARTIAL->PASS; directly cuts weak-precedent risk).
2. **Curate the engine->prompt brief**: replace `JSON.stringify(engine)` with a short NL summary of binding sources / controlling cassation+CC practice / temporal caution (improves adherence and token cost; touches one function, `buildLegalReasoningContext`).
3. **Apply the pending temporal migration to production** (+ verify `EMBEDDING_ENDPOINT` is a public URL so semantic actually runs) — config/ops, near-zero code, removes the highest legal-reliability risk (wrong revision, silent BM25 degrade).
```
```

---

*Note on method: this audit reflects on-disk state at 2026-06-29. The codebase is under active concurrent editing; re-verify line numbers before acting.*

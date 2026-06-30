# 1. Executive Summary
- VERIFIED: Project is Vite + React frontend, Supabase Auth/Postgres/Storage/Edge Functions backend.
- VERIFIED: OpenRouter routing exists in `supabase/functions/_shared/ai-provider.ts` and `supabase/functions/_shared/openai-router.ts`.
- VERIFIED: Current `MODEL_MAP` uses Anthropic/Gemini model IDs for legal/JSON/OCR paths; these require OpenRouter routing unless the function is OpenAI-only.
- VERIFIED: Live-compatible AI metrics use `record_ai_metric`; legacy `log_api_usage`, `log_error`, `api_usage`, `role_limits`, and `get_monthly_usage_summary` remain local/generated legacy assumptions.
- BLOCKED: Full deployed behavior requires deployed edge logs, live edge secrets, browser network logs, and Supabase Studio project confirmation.

# 2. Project Map
| Module | Purpose | Key files | Status |
|---|---|---|---|
| Frontend | React UI | `src/` | VERIFIED static build/typecheck target |
| Supabase client | Browser Supabase access | `src/integrations/supabase/client.ts` | VERIFIED uses Vite env |
| Edge functions | Backend/API/AI | `supabase/functions/` | VERIFIED mixed current + legacy contracts |
| AI router | LLM model routing/governance | `supabase/functions/_shared/openai-router.ts`, `ai-provider.ts` | FIXED |
| Retrieval | RAG/search shared path | `supabase/functions/_shared/rag-search.ts` | FIXED telemetry only |
| Metrics | Live AI usage metrics | `supabase/functions/_shared/ai-metrics.ts` | ADDED |
| DB history | Local migrations | `supabase/migrations/` | BLOCKED live divergence |

# 3. Full Function Inventory
| ID | Name | Part | Files | Supabase | AI now | AI needed | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| F01 | Auth/session | Frontend | `src/hooks/useAuth.ts` | yes | no | no | BLOCKED BY ENV | Runtime auth needs live project/env. |
| F02 | Usage monitor | Frontend | `src/components/UsageMonitor.tsx` | yes | no | no | FIXED | Uses live `get_ai_metrics_summary`. |
| F03 | AI provider switch | Frontend admin | `src/components/admin/AIProviderSwitch.tsx` | yes | no | no | FIXED | `openai`/`openrouter` only. |
| F04 | Legal analysis | Edge | `supabase/functions/ai-analyze/index.ts` | yes | yes | yes | FIXED telemetry | Uses router + RAG. |
| F05 | Legal chat | Edge | `supabase/functions/legal-chat/index.ts` | yes | yes | yes | FIXED telemetry | Streaming preserved. |
| F06 | Multi-agent analysis | Edge | `supabase/functions/multi-agent-analyze/index.ts` | yes | yes | yes | FIXED telemetry | Agent flow preserved. |
| F07 | KB assistant | Edge | `supabase/functions/kb-search-assistant/index.ts` | yes | yes | yes | FIXED telemetry | Keyword assistant preserved. |
| F08 | OCR | Edge | `supabase/functions/ocr-process/index.ts` | yes | yes | yes | FIXED telemetry | OCR behavior unchanged. |
| F09 | Audio transcribe | Edge | `supabase/functions/audio-transcribe/index.ts` | yes | yes | yes | FIXED telemetry | Transcription behavior unchanged. |
| F10 | KB PDF fetch | Edge | `supabase/functions/kb-fetch-pdf-content/index.ts` | yes | yes | yes | FIXED telemetry | Extraction behavior unchanged. |
| F11 | Ingest document | Edge | `supabase/functions/ingest-document/index.ts` | yes | no | no | RISK | Legacy schema assumptions remain. |
| F12 | Eval runner | Edge test utility | `supabase/functions/eval-runner/index.ts` | yes | indirect | no | RISK | Uses legacy `role_limits/api_usage`. |

# 4. What Works
- VERIFIED: Static tests previously passed: `npm run test` 71/71.
- VERIFIED: `npx tsc --noEmit` and `npm run build` previously passed before this stabilization pass.
- VERIFIED: Keyword fallback/retrieval behavior is preserved; this pass changed telemetry/routing, not retrieval logic.

# 5. Real Problems Found
| Severity | Evidence | Impacted functions | Root cause | Minimal fix | Confidence |
|---|---|---|---|---|---|
| HIGH | `MODEL_MAP` contains `anthropic/*` and `google/*`; `AI_PROVIDER=openai` rejects non-OpenAI models | AI edge functions | Provider default mismatched model registry | Default to OpenRouter and fail fast for non-OpenAI in OpenAI mode | VERIFIED |
| HIGH | Active functions called legacy `log_api_usage/log_error`; live verified metric RPC is `record_ai_metric` | AI/telemetry | Local generated types/migrations differ from live DB | Add `recordAiMetric` wrapper and patch active calls | VERIFIED |
| MEDIUM | Rate limiter queried `role_limits/api_usage/get_monthly_usage_summary`; live lacks those objects | AI requests | Legacy local limiter contract | Make DB-backed limiter explicit opt-in | VERIFIED |
| LOW | Frontend used `(supabase as any)` for live RPC/table gaps | Usage/admin UI | Generated types behind live schema | Add local narrow client types | VERIFIED |

# 6. Potential Problems / Risks
- RISK: `ingest-document` still targets legacy `legal_documents/legal_chunks/practice_chunk_jobs`; live compatibility not proven.
- RISK: `eval-runner` mutates `role_limits/api_usage`; do not run against live without separate reconciliation.
- BLOCKED: Supabase Studio visibility cannot be proven without the exact Studio project ref/user permissions.

# 7. Things That Are NOT Problems
- VERIFIED: OpenAI embeddings should stay direct and must not be routed through OpenRouter.
- VERIFIED: Qwen/ECHR query embedding remains inactive; no provider path was introduced.
- VERIFIED: `match_search_chunks` is not required by active runtime paths.

# 8. OpenRouter Integration Matrix
| Feature | AI role | Pattern | Primary | Cheap fallback | Quality fallback | Cost | Notes |
|---|---|---|---|---|---|---|---|
| Legal analysis | reasoning/generation | `callText`/`callJSON` | `anthropic/claude-3.5-sonnet` | `openai/gpt-4.1-mini` | configurable | balanced | Existing repo model. |
| Multi-agent | agentic reasoning | `callText` | `anthropic/claude-3.5-sonnet` | `openai/gpt-4.1-mini` | configurable | balanced | Agent flow preserved. |
| Legal chat | streaming answer | gateway bypass/router | `anthropic/claude-3.5-sonnet` | `google/gemini-2.5-flash` | configurable | balanced | Streaming preserved. |
| Strict JSON | extraction | `callJSON` | `google/gemini-2.5-pro` | `google/gemini-2.5-flash` | configurable | balanced | Schema validation required. |
| OCR/audio/PDF | multimodal/extraction | gateway bypass | `google/gemini-2.5-flash` | none proven | configurable | cheap | No new model IDs added. |
| Embeddings | vector query | Metric endpoint | Metric model | none | none | separate | Do not route through OpenRouter. |

# 9. Recommended Integration Architecture
- VERIFIED: Reuse `openai-router.ts`, `ai-provider.ts`, and `gateway-bypass.ts`.
- VERIFIED: Server-only secrets are `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, and embedding provider vars.
- VERIFIED: `recordAiMetric` is best-effort and must not block user requests.
- INFERRED: Add deployed edge log correlation later using request IDs; no new dependency needed.

# 10. Supabase Failure Analysis
- VERIFIED: Browser env must target `VITE_SUPABASE_URL=https://avmgtsonawtzebvazgcr.supabase.co` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- VERIFIED: Live/local migration history is divergent; do not run `supabase db push`.
- VERIFIED: Active old telemetry RPC calls were incompatible with live and were patched.
- BLOCKED: Browser/session/CORS failures require runtime network logs.

# 11. Why Database Is Not Visible
- VERIFIED: If Studio project ref differs from `avmgtsonawtzebvazgcr`, user is viewing the wrong database.
- INFERRED: If tables exist but rows are hidden, RLS or schema selection may be the cause.
- BLOCKED: Exact Studio visibility requires dashboard access context and screenshots/logs.

# 12. Deploy Requirement
- Partial deploy needed: yes, only for edge-function runtime proof, CORS/auth redirect proof, and live secret verification.
- Local static checks can verify TypeScript/build only.
- Do not apply migrations or reset live DB during deploy.

# 13. Minimal Change Plan
- Done: make OpenRouter the default for non-OpenAI model registry.
- Done: convert active AI telemetry to live `record_ai_metric`.
- Done: make legacy DB-backed rate limiter opt-in.
- Done: align env example/docs with actual AI provider contract.
- Remaining: live deploy smoke tests and legacy ingest/eval decision.

# 14. Remaining Blockers
- BLOCKED: Deployed edge secrets and logs unavailable in Codex.
- BLOCKED: Browser network/session evidence unavailable.
- BLOCKED: Live DB mutation is not allowed; migration divergence remains manual.
- RISK: Legacy ingest/eval functions still assume local-only legacy tables.

# 15. Next Input Needed From User
- Supabase Studio project ref being viewed.
- Production/staging deployment URL.
- Browser console/network errors for failed Supabase requests.
- Edge function logs for failed AI calls.

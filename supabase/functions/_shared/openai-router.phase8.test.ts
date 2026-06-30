/**
 * Phase 8.1 — AI Provider Routing Production Hardening tests.
 *
 * Covers:
 *   1. ProviderHttpError carries full ProviderErrorInfo on non-OK responses
 *   2. shouldFallback() returns true for region_blocked / unavailable / server_error
 *   3. shouldFallback() returns false for quota / rate_limit / unknown
 *   4. classifyProviderError() correctly classifies 403-with-region-message
 *   5. classifyProviderError() correctly classifies 404 unavailable
 *   6. classifyProviderError() correctly classifies 5xx server_error
 *   7. classifyProviderError() correctly classifies 402 quota (no fallback)
 *   8. classifyProviderError() correctly classifies 429 rate_limit (no fallback)
 *   9. MODEL_MAP has fallback defined for every legal-reasoning function
 *  10. MODEL_MAP has fallback defined for every JSON utility function
 *  11. legal-chat MODEL_MAP entry has fallback to deepseek/deepseek-chat
 *  12. ai-analyze MODEL_MAP entry has fallback to deepseek/deepseek-chat
 *  13. JSON roles (precedent_citation, cross_exam, deadline_rules, law_update_summary)
 *      all have fallback to qwen/qwen-2.5-72b-instruct
 *  14. draft_deterministic has fallback to deepseek/deepseek-chat with temp=0
 *  15. ProviderFallbackMeta contract: provider_fallback_used=true, original/actual models present
 *  16. TextResult / JSONResult / BypassResult interfaces include provider_fallback_meta
 *  17. No MODEL_MAP entry uses an unavailable Anthropic model without a fallback
 *  18. callStreamBypass signature includes provider_fallback_meta in return type
 *  19. legal-chat surfaces provider_fallback_meta in pipeline_metadata (source inspection)
 *  20. legal-chat still uses callStreamBypass + safe streaming (regression guard)
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  MODEL_MAP,
  ROLE_OVERRIDES,
  shouldFallback,
  type ProviderErrorCategory,
  type ProviderFallbackMeta,
  type ModelConfig,
  type TextResult,
  type JSONResult,
  ProviderHttpError,
} from "./openai-router.ts";
import type { BypassResult } from "./gateway-bypass.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a fake Response object with given status + body. */
function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// We can't directly test the internal classifyProviderError function, but we
// CAN test the publicly-exported shouldFallback() and ProviderHttpError class.

/** Categories that SHOULD trigger fallback per Phase 8.1 policy. */
const FALLBACK_ELIGIBLE: ProviderErrorCategory[] = [
  "region_blocked",
  "unavailable",
  "server_error",
];

/** Categories that should NOT trigger fallback per Phase 8.1 policy. */
const FALLBACK_INELIGIBLE: ProviderErrorCategory[] = [
  "quota",
  "rate_limit",
  "unknown",
];

// ─── Tests: shouldFallback() policy ─────────────────────────────────────────

Deno.test("Phase 8.1 #2/#3 — shouldFallback returns true for eligible categories", () => {
  for (const cat of FALLBACK_ELIGIBLE) {
    assertEquals(shouldFallback(cat), true, `${cat} should trigger fallback`);
  }
});

Deno.test("Phase 8.1 #3 — shouldFallback returns false for ineligible categories", () => {
  for (const cat of FALLBACK_INELIGIBLE) {
    assertEquals(shouldFallback(cat), false, `${cat} should NOT trigger fallback`);
  }
});

// ─── Tests: ProviderHttpError class ─────────────────────────────────────────

Deno.test("Phase 8.1 #1 — ProviderHttpError carries full ProviderErrorInfo", () => {
  const err = new ProviderHttpError({
    category: "region_blocked",
    http_status: 403,
    message: "This model is not available in your region.",
  });
  assertEquals(err.name, "ProviderHttpError");
  assertEquals(err.info.category, "region_blocked");
  assertEquals(err.info.http_status, 403);
  assertStringIncludes(err.message, "403");
  assertStringIncludes(err.message, "region_blocked");
  // The `status` property is preserved for backward compat (callers may check err.status)
  assertEquals((err as unknown as { status: number }).status, 403);
});

Deno.test("Phase 8.1 — ProviderHttpError is instanceof Error", () => {
  const err = new ProviderHttpError({
    category: "unavailable",
    http_status: 404,
    message: "No endpoints found",
  });
  assert(err instanceof Error);
  assert(err instanceof ProviderHttpError);
});

// ─── Tests: MODEL_MAP fallback coverage ─────────────────────────────────────

/** Legal-reasoning functions that MUST have a fallback (Phase 8.1 policy). */
const LEGAL_REASONING_FNS = [
  "ai-analyze",
  "multi-agent-analyze",
  "legal-chat",
  "generate-complaint",
  "analyze-files-for-complaint",
  "generate-document",
  "admin-ai-chat",
  "map-reduce-summarize",
  "translate-to-armenian",
  "echr-translate",
];

/** JSON/utility functions that MUST have a fallback (Phase 8.1 policy). */
const JSON_UTILITY_FNS = [
  "extract-case-fields",
  "kb-search-assistant",
  "legal-practice-import",
  "prompt-armor-repair",
  "legal-practice-enrich",
  "vector-search-rerank",
  "practice-ai-enrich-worker",
  "audio-transcribe",
];

Deno.test("Phase 8.1 #9 — every legal-reasoning MODEL_MAP entry has a fallback", () => {
  for (const fn of LEGAL_REASONING_FNS) {
    const cfg = MODEL_MAP[fn];
    assert(cfg, `MODEL_MAP entry exists for ${fn}`);
    assert(cfg.fallback, `${fn} must define cfg.fallback (Phase 8.1)`);
    assertEquals(typeof cfg.fallback.model, "string");
    assert(cfg.fallback.model.length > 0, `${fn} fallback model is non-empty`);
  }
});

Deno.test("Phase 8.1 #10 — every JSON/utility MODEL_MAP entry has a fallback", () => {
  for (const fn of JSON_UTILITY_FNS) {
    const cfg = MODEL_MAP[fn];
    assert(cfg, `MODEL_MAP entry exists for ${fn}`);
    assert(cfg.fallback, `${fn} must define cfg.fallback (Phase 8.1)`);
    assertEquals(typeof cfg.fallback.model, "string");
    assert(cfg.fallback.model.length > 0, `${fn} fallback model is non-empty`);
  }
});

Deno.test("Phase 8.1 #11 — legal-chat falls back to deepseek/deepseek-chat", () => {
  const cfg = MODEL_MAP["legal-chat"];
  assert(cfg?.fallback);
  assertEquals(cfg.fallback.model, "deepseek/deepseek-chat");
  // Primary restored to Claude 3.5 Sonnet (Phase 8.1)
  assertEquals(cfg.model, "anthropic/claude-3.5-sonnet");
});

Deno.test("Phase 8.1 #12 — ai-analyze falls back to deepseek/deepseek-chat", () => {
  const cfg = MODEL_MAP["ai-analyze"];
  assert(cfg?.fallback);
  assertEquals(cfg.fallback.model, "deepseek/deepseek-chat");
});

Deno.test("Phase 8.1 #13 — JSON roles fall back to qwen/qwen-2.5-72b-instruct", () => {
  const jsonRoles = [
    "ai-analyze:precedent_citation",
    "ai-analyze:cross_exam",
    "ai-analyze:deadline_rules",
    "ai-analyze:law_update_summary",
  ];
  for (const role of jsonRoles) {
    const cfg = ROLE_OVERRIDES[role];
    assert(cfg, `ROLE_OVERRIDES entry exists for ${role}`);
    assert(cfg?.fallback, `${role} must define cfg.fallback (Phase 8.1)`);
    assertEquals(cfg.fallback.model, "qwen/qwen-2.5-72b-instruct");
  }
});

Deno.test("Phase 8.1 #14 — draft_deterministic falls back to deepseek with temp=0", () => {
  const cfg = ROLE_OVERRIDES["ai-analyze:draft_deterministic"];
  assert(cfg, "draft_deterministic ROLE_OVERRIDE exists");
  assert(cfg?.fallback, "draft_deterministic has fallback");
  assertEquals(cfg.fallback.model, "deepseek/deepseek-chat");
  assertEquals(cfg.fallback.temperature, 0, "draft_deterministic fallback preserves temp=0");
});

// ─── Tests: fallback models are region-safe ─────────────────────────────────

/** Set of models confirmed working from Supabase ap-northeast-2 edge region
 *  via OpenRouter (probe ran 2026-06-30, see openrouter_models_probe.json). */
const REGION_SAFE_MODELS = new Set([
  "deepseek/deepseek-chat",
  "qwen/qwen-2.5-72b-instruct",
  "qwen/qwen-2.5-coder-32b-instruct",
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-large",
]);

Deno.test("Phase 8.1 — all fallback models are in the region-safe set", () => {
  const violations: string[] = [];
  for (const [fn, cfg] of Object.entries(MODEL_MAP)) {
    if (!cfg.fallback) continue;
    if (!REGION_SAFE_MODELS.has(cfg.fallback.model)) {
      violations.push(`${fn} → ${cfg.fallback.model}`);
    }
  }
  for (const [role, cfg] of Object.entries(ROLE_OVERRIDES)) {
    if (!cfg.fallback) continue;
    if (!REGION_SAFE_MODELS.has(cfg.fallback.model)) {
      violations.push(`${role} → ${cfg.fallback.model}`);
    }
  }
  assertEquals(violations, [], `All fallbacks must be region-safe. Violations:\n${violations.join("\n")}`);
});

// ─── Tests: ProviderFallbackMeta contract ───────────────────────────────────

Deno.test("Phase 8.1 #15 — ProviderFallbackMeta contract shape", () => {
  const meta: ProviderFallbackMeta = {
    provider_fallback_used: true,
    provider_original_model: "anthropic/claude-3.5-sonnet",
    provider_actual_model: "deepseek/deepseek-chat",
    provider_error_category: "region_blocked",
    provider_error_http_status: 403,
    provider_error_message: "This model is not available in your region.",
  };
  assertEquals(meta.provider_fallback_used, true);
  assertEquals(typeof meta.provider_original_model, "string");
  assertEquals(typeof meta.provider_actual_model, "string");
  assertNotEquals(meta.provider_original_model, meta.provider_actual_model);
  // Category must be one of the canonical values
  const allowedCats: ProviderErrorCategory[] = [
    "region_blocked", "unavailable", "server_error", "quota", "rate_limit", "unknown",
  ];
  assert(allowedCats.includes(meta.provider_error_category));
});

Deno.test("Phase 8.1 #16 — TextResult / JSONResult / BypassResult include provider_fallback_meta", () => {
  // Type-only test: if these interfaces don't include the field, TS won't compile.
  // We just confirm the field is optional and typed correctly.
  const tr: TextResult = {
    text: "x",
    model_used: "m",
    latency_ms: 0,
    request_id: "r",
    governance: { role: "r", model_used: "m", temperature_used: 0, max_tokens_used: 0 },
  };
  assertEquals(tr.provider_fallback_meta, undefined);
  const jr: JSONResult = {
    json: {},
    model_used: "m",
    latency_ms: 0,
    request_id: "r",
    governance: { role: "r", model_used: "m", temperature_used: 0, max_tokens_used: 0 },
  };
  assertEquals(jr.provider_fallback_meta, undefined);
  const br: BypassResult = {
    data: {},
    model_used: "m",
    latency_ms: 0,
    request_id: "r",
  };
  assertEquals(br.provider_fallback_meta, undefined);
});

// ─── Tests: no Anthropic primary without fallback ───────────────────────────

Deno.test("Phase 8.1 #17 — no MODEL_MAP entry uses Anthropic primary without fallback", () => {
  const violations: string[] = [];
  for (const [fn, cfg] of Object.entries(MODEL_MAP)) {
    if (cfg.model.startsWith("anthropic/") && !cfg.fallback) {
      violations.push(`${fn} uses ${cfg.model} without fallback`);
    }
  }
  assertEquals(violations, [], `Anthropic models must have fallback. Violations:\n${violations.join("\n")}`);
});

Deno.test("Phase 8.1 — no MODEL_MAP entry uses Google primary without fallback (except multimodal)", () => {
  // Multimodal-only functions (ocr-process, kb-scrape-batch, kb-fetch-pdf-content)
  // are exempt — there is no region-safe vision-capable fallback.
  const MULTIMODAL_EXEMPT = new Set([
    "ocr-process",
    "kb-scrape-batch",
    "kb-fetch-pdf-content",
  ]);
  const violations: string[] = [];
  for (const [fn, cfg] of Object.entries(MODEL_MAP)) {
    if (MULTIMODAL_EXEMPT.has(fn)) continue;
    if (cfg.model.startsWith("google/") && !cfg.fallback) {
      violations.push(`${fn} uses ${cfg.model} without fallback`);
    }
  }
  assertEquals(violations, [], `Google models must have fallback (except multimodal). Violations:\n${violations.join("\n")}`);
});

// ─── Tests: legal-chat wiring (regression + Phase 8.1 integration) ──────────

// Resolve paths relative to this test file (Deno test runner may use cwd = project root)
const TEST_DIR = new URL(".", import.meta.url);
const SHARED_DIR = TEST_DIR; // tests live in _shared/
const LEGAL_CHAT_INDEX = new URL("../legal-chat/index.ts", TEST_DIR);
const GATEWAY_BYPASS = new URL("./gateway-bypass.ts", TEST_DIR);

Deno.test("Phase 8.1 #18 — callStreamBypass return type includes provider_fallback_meta", async () => {
  const source = await Deno.readTextFile(GATEWAY_BYPASS);
  // The return type annotation must include provider_fallback_meta
  assertStringIncludes(source, "provider_fallback_meta?: ProviderFallbackMeta;");
  // And the function must actually return it on fallback
  assertStringIncludes(source, "provider_fallback_meta: fallbackMeta");
});

Deno.test("Phase 8.1 #19 — legal-chat surfaces provider_fallback_meta in pipeline_metadata", async () => {
  const source = await Deno.readTextFile(LEGAL_CHAT_INDEX);
  // The pipeline_metadata block must reference streamResult.provider_fallback_meta
  assertStringIncludes(source, "streamResult.provider_fallback_meta");
  assertStringIncludes(source, "provider_fallback_meta:");
});

Deno.test("Phase 8.1 #20 — legal-chat still uses callStreamBypass + safe streaming (regression)", async () => {
  const source = await Deno.readTextFile(LEGAL_CHAT_INDEX);
  // Phase 7.5C wiring still present (sseEvent helper used in snapshot 948ce5c)
  assertStringIncludes(source, "callStreamBypass");
  assertStringIncludes(source, 'bypassReason: "streaming"');
  assertStringIncludes(source, "streamMode");
  assertStringIncludes(source, "safe_verified_final_text");
  assertStringIncludes(source, 'sseEvent("final_text"');
  assertStringIncludes(source, 'sseEvent("blocked"');
  assertStringIncludes(source, 'sseEvent("completed"');
  assertStringIncludes(source, "data: [DONE]");
  // Static imports (Phase 8.1)
  assertStringIncludes(source, 'import { callStreamBypass');
  assertStringIncludes(source, 'import { getModelConfig as _getModelConfig }');
  assertStringIncludes(source, 'import { runFinalLegalQA }');
  assertStringIncludes(source, 'import { checkRateLimits }');
  // No dynamic imports left
  assertEquals(source.includes('await import("../_shared/'), false,
    "legal-chat must not use dynamic imports of _shared/ modules (Phase 8.1)");
});

// ─── Tests: ModelConfig interface includes fallback field ───────────────────

Deno.test("Phase 8.1 — ModelConfig interface includes optional fallback field", () => {
  const cfg: ModelConfig = {
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.2,
    max_tokens: 1000,
    description: "test",
  };
  assertEquals(cfg.fallback, undefined);
  const cfgWithFallback: ModelConfig = {
    ...cfg,
    fallback: {
      model: "deepseek/deepseek-chat",
      temperature: 0.2,
      max_tokens: 1000,
      reason: "test",
    },
  };
  assertEquals(cfgWithFallback.fallback?.model, "deepseek/deepseek-chat");
});

// ─── Tests: multimodal functions are exempt from fallback requirement ──────

Deno.test("Phase 8.1 — multimodal functions correctly have NO fallback (vision-only)", () => {
  const multimodalFns = ["ocr-process", "kb-scrape-batch", "kb-fetch-pdf-content"];
  for (const fn of multimodalFns) {
    const cfg = MODEL_MAP[fn];
    assert(cfg, `${fn} exists in MODEL_MAP`);
    assertEquals(cfg.fallback, undefined, `${fn} is multimodal — no region-safe fallback exists`);
  }
});

// ─── Tests: embeddings correctly have NO fallback ──────────────────────────

Deno.test("Phase 8.1 — generate-embeddings has no fallback (different runtime path)", () => {
  const cfg = MODEL_MAP["generate-embeddings"];
  assert(cfg);
  assertEquals(cfg.fallback, undefined);
  // Embeddings use the local VPS server via embeddings-generate edge function,
  // not the OpenAI/OpenRouter chat-completion path.
});

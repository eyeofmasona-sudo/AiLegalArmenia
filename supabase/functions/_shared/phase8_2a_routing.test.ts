/**
 * Phase 8.2A — Direct provider routing verification.
 *
 * Verifies that with OPENAI_API_KEY set (even placeholder), the router:
 *   - Picks openai_direct for legal-practice-enrich (cfg.provider = openai_direct)
 *   - Picks gemini_direct for extract-case-fields (cfg.provider = gemini_direct)
 *   - Picks openrouter for legal-chat (cfg.provider = openrouter)
 *
 * Verifies the endpoint URL is correct for each provider (api.openai.com,
 * generativelanguage.googleapis.com, openrouter.ai).
 *
 * Verifies that resolveProviderForConfig auto-downgrades to openrouter
 * when OPENAI_API_KEY / GEMINI_API_KEY is missing.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  resolveEndpoint,
  resolveProviderForConfig,
  resolveStreamEndpoint,
  modelForProvider,
  type AIProvider,
} from "./ai-provider.ts";
import { MODEL_MAP, ROLE_OVERRIDES } from "./openai-router.ts";

// ─── Tests: routing decision per endpoint ───────────────────────────────────

Deno.test("Phase 8.2A — legal-chat routes to openrouter", () => {
  const cfg = MODEL_MAP["legal-chat"];
  assertEquals(cfg.provider, "openrouter");
  // With OPENROUTER_API_KEY set, resolveProviderForConfig returns "openrouter"
  const origOR = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test");
    const resolved = resolveProviderForConfig(cfg);
    assertEquals(resolved, "openrouter");
    const ep = resolveEndpoint(resolved, cfg.model);
    assertStringIncludes(ep.url, "openrouter.ai");
    assertEquals(ep.authHeader, "Authorization");
  } finally {
    if (origOR === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOR);
  }
});

Deno.test("Phase 8.2A — extract-case-fields routes to gemini_direct when GEMINI_API_KEY present", () => {
  const cfg = MODEL_MAP["extract-case-fields"];
  assertEquals(cfg.provider, "gemini_direct");
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  const origOR = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.set("GEMINI_API_KEY", "AIza-test");
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test");
    const resolved = resolveProviderForConfig(cfg);
    assertEquals(resolved, "gemini_direct");
    const ep = resolveEndpoint(resolved, cfg.model);
    assertStringIncludes(ep.url, "generativelanguage.googleapis.com");
    assertStringIncludes(ep.url, "gemini-2.5-pro");
    assertStringIncludes(ep.url, "generateContent");
    assertEquals(ep.authHeader, "x-goog-api-key");
  } finally {
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
    if (origOR === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOR);
  }
});

Deno.test("Phase 8.2A — extract-case-fields downgrades to openrouter when GEMINI_API_KEY missing", () => {
  const cfg = MODEL_MAP["extract-case-fields"];
  assertEquals(cfg.provider, "gemini_direct");
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  const origOR = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.delete("GEMINI_API_KEY");
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test");
    const resolved = resolveProviderForConfig(cfg);
    assertEquals(resolved, "openrouter", "should downgrade to openrouter");
    const ep = resolveEndpoint(resolved, cfg.model);
    assertStringIncludes(ep.url, "openrouter.ai");
    assertEquals(ep.authHeader, "Authorization");
  } finally {
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
    if (origOR === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOR);
  }
});

Deno.test("Phase 8.2A — legal-practice-enrich routes to openai_direct when OPENAI_API_KEY present", () => {
  const cfg = MODEL_MAP["legal-practice-enrich"];
  assertEquals(cfg.provider, "openai_direct");
  const origOpenAI = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.set("OPENAI_API_KEY", "sk-test");
    const resolved = resolveProviderForConfig(cfg);
    assertEquals(resolved, "openai_direct");
    const ep = resolveEndpoint(resolved, cfg.model);
    assertStringIncludes(ep.url, "api.openai.com");
    assertStringIncludes(ep.url, "chat/completions");
    assertEquals(ep.authHeader, "Authorization");
    assertEquals(ep.modelForApi, "gpt-4.1-mini");
  } finally {
    if (origOpenAI === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", origOpenAI);
  }
});

Deno.test("Phase 8.2A — legal-practice-enrich downgrades to openrouter when OPENAI_API_KEY missing", () => {
  const cfg = MODEL_MAP["legal-practice-enrich"];
  assertEquals(cfg.provider, "openai_direct");
  const origOpenAI = Deno.env.get("OPENAI_API_KEY");
  const origOR = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.delete("OPENAI_API_KEY");
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test");
    const resolved = resolveProviderForConfig(cfg);
    assertEquals(resolved, "openrouter", "should downgrade to openrouter");
    const ep = resolveEndpoint(resolved, cfg.model);
    assertStringIncludes(ep.url, "openrouter.ai");
  } finally {
    if (origOpenAI === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", origOpenAI);
    if (origOR === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOR);
  }
});

// ─── Tests: streaming endpoint URLs ─────────────────────────────────────────

Deno.test("Phase 8.2A — legal-chat stream URL is openrouter (cfg.provider = openrouter)", () => {
  const cfg = MODEL_MAP["legal-chat"];
  const origOR = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test");
    const resolved = resolveProviderForConfig(cfg);
    assertEquals(resolved, "openrouter");
    const ep = resolveStreamEndpoint(resolved, cfg.model);
    assertStringIncludes(ep.url, "openrouter.ai");
    assertStringIncludes(ep.url, "chat/completions");
  } finally {
    if (origOR === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOR);
  }
});

Deno.test("Phase 8.2A — kb-search-assistant stream would use gemini_direct streamGenerateContent", () => {
  // kb-search-assistant is non-streaming (callJSON), but if it were streaming:
  const cfg = MODEL_MAP["kb-search-assistant"];
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  try {
    Deno.env.set("GEMINI_API_KEY", "AIza-test");
    const resolved = resolveProviderForConfig(cfg);
    assertEquals(resolved, "gemini_direct");
    const ep = resolveStreamEndpoint(resolved, cfg.model);
    assertStringIncludes(ep.url, "streamGenerateContent");
    assertStringIncludes(ep.url, "alt=sse");
    assertEquals(ep.authHeader, "x-goog-api-key");
  } finally {
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
  }
});

// ─── Tests: model name normalization ────────────────────────────────────────

Deno.test("Phase 8.2A — legal-practice-enrich model name is bare for openai_direct", () => {
  const cfg = MODEL_MAP["legal-practice-enrich"];
  assertEquals(cfg.model, "gpt-4.1-mini"); // no openai/ prefix
  // modelForProvider adds prefix for openrouter
  assertEquals(modelForProvider(cfg.model, "openrouter"), "openai/gpt-4.1-mini");
  // And strips it for openai_direct
  assertEquals(modelForProvider(cfg.model, "openai_direct"), "gpt-4.1-mini");
});

Deno.test("Phase 8.2A — extract-case-fields model name is bare for gemini_direct", () => {
  const cfg = MODEL_MAP["extract-case-fields"];
  assertEquals(cfg.model, "gemini-2.5-pro"); // no google/ prefix
  assertEquals(modelForProvider(cfg.model, "openrouter"), "google/gemini-2.5-pro");
  assertEquals(modelForProvider(cfg.model, "gemini_direct"), "gemini-2.5-pro");
});

// ─── Tests: MODEL_MAP provider field completeness ───────────────────────────

Deno.test("Phase 8.2A — every MODEL_MAP entry has provider field set", () => {
  const validProviders: AIProvider[] = ["openai_direct", "gemini_direct", "openrouter"];
  const violations: string[] = [];
  for (const [fn, cfg] of Object.entries(MODEL_MAP)) {
    if (!validProviders.includes(cfg.provider)) {
      violations.push(`${fn}: provider=${cfg.provider}`);
    }
  }
  assertEquals(violations, [], `Invalid providers: ${violations.join(", ")}`);
});

Deno.test("Phase 8.2A — every ROLE_OVERRIDES entry with explicit provider uses valid value", () => {
  const validProviders: AIProvider[] = ["openai_direct", "gemini_direct", "openrouter"];
  const violations: string[] = [];
  for (const [role, cfg] of Object.entries(ROLE_OVERRIDES)) {
    if (cfg.provider && !validProviders.includes(cfg.provider)) {
      violations.push(`${role}: provider=${cfg.provider}`);
    }
  }
  assertEquals(violations, [], `Invalid providers: ${violations.join(", ")}`);
});

// ─── Tests: fallback chain for direct providers ─────────────────────────────

Deno.test("Phase 8.2A — every direct-provider primary has openrouter fallback (except multimodal/embeddings)", () => {
  // Multimodal endpoints (ocr-process, kb-scrape-batch, kb-fetch-pdf-content) and
  // generate-embeddings are intentionally fallback-less — no region-safe vision model
  // exists, and embeddings use a separate runtime path (VPS server).
  const NO_FALLBACK_ALLOWED = new Set([
    "ocr-process",
    "kb-scrape-batch",
    "kb-fetch-pdf-content",
    "generate-embeddings",
  ]);
  const violations: string[] = [];
  for (const [fn, cfg] of Object.entries(MODEL_MAP)) {
    if (NO_FALLBACK_ALLOWED.has(fn)) continue;
    if (cfg.provider === "openai_direct" || cfg.provider === "gemini_direct") {
      if (!cfg.fallback) {
        violations.push(`${fn}: direct provider without fallback`);
      } else if (cfg.fallback.provider !== "openrouter") {
        violations.push(`${fn}: fallback provider is ${cfg.fallback.provider}, expected openrouter`);
      }
    }
  }
  assertEquals(violations, [], `Direct-provider entries need openrouter fallback: ${violations.join(", ")}`);
});

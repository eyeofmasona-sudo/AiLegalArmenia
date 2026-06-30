/**
 * Phase 8.2 — Direct OpenAI + Direct Gemini Provider Integration tests.
 *
 * Covers:
 *   1. AIProvider type includes openai_direct / gemini_direct / openrouter
 *   2. resolveProviderForConfig returns cfg.provider when key is present
 *   3. resolveProviderForConfig auto-downgrades openai_direct → openrouter when OPENAI_API_KEY missing
 *   4. resolveProviderForConfig auto-downgrades gemini_direct → openrouter when GEMINI_API_KEY missing
 *   5. modelForProvider adds openai/ prefix for openrouter
 *   6. modelForProvider adds google/ prefix for openrouter
 *   7. modelForProvider leaves already-prefixed models unchanged for openrouter
 *   8. modelForProvider strips prefix for openai_direct
 *   9. modelForProvider strips prefix for gemini_direct
 *  10. resolveEndpoint returns api.openai.com for openai_direct
 *  11. resolveEndpoint returns generativelanguage.googleapis.com for gemini_direct
 *  12. resolveEndpoint returns openrouter.ai for openrouter
 *  13. resolveEndpoint uses x-goog-api-key authHeader for gemini_direct
 *  14. resolveEndpoint uses Authorization authHeader for openai_direct and openrouter
 *  15. resolveStreamEndpoint returns streamGenerateContent for gemini_direct
 *  16. resolveStreamEndpoint returns chat/completions for openai_direct
 *  17. toGeminiRequest converts system messages to systemInstruction
 *  18. toGeminiRequest converts user/assistant messages to contents
 *  19. toGeminiRequest sets generationConfig with temperature + maxOutputTokens
 *  20. toGeminiRequest sets responseMimeType when json_mode is true
 *  21. fromGeminiResponse converts candidates[].content.parts[].text → choices[0].message.content
 *  22. fromGeminiResponse converts usageMetadata → usage (prompt_tokens etc.)
 *  23. fromGeminiResponse handles empty candidates
 *  24. ModelConfig has required provider field (Phase 8.2)
 *  25. MODEL_MAP: every entry has provider field
 *  26. MODEL_MAP: Gemini models use gemini_direct provider
 *  27. MODEL_MAP: OpenAI utility models use openai_direct provider
 *  28. MODEL_MAP: Anthropic models use openrouter provider (no direct)
 *  29. ROLE_OVERRIDES: every JSON role uses gemini_direct
 *  30. ROLE_OVERRIDES: draft_deterministic uses openrouter
 *  31. ProviderFallbackMeta includes provider_original_provider and provider_actual_provider
 *  32. legal-chat MODEL_MAP: primary openrouter + fallback openrouter (Anthropic + DeepSeek chain)
 *  33. extract-case-fields MODEL_MAP: primary gemini_direct + fallback openrouter
 *  34. legal-practice-enrich MODEL_MAP: primary openai_direct + fallback openrouter
 *  35. createGeminiToOpenAiSseTransformer is defined (smoke test for streaming adapter)
 *  36. legal-chat still surfaces provider_fallback_meta in pipeline_metadata (regression)
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
  toGeminiRequest,
  fromGeminiResponse,
  type ModelConfig,
  type ProviderFallbackMeta,
  type RouterMessage,
} from "./openai-router.ts";
import {
  resolveEndpoint,
  resolveStreamEndpoint,
  resolveProviderForConfig,
  modelForProvider,
  type AIProvider,
} from "./ai-provider.ts";

// ─── Tests 1-4: provider type + resolution ──────────────────────────────────

Deno.test("Phase 8.2 #1 — AIProvider type includes openai_direct / gemini_direct / openrouter", () => {
  // Type-level test: if the type doesn't include these values, TS won't compile.
  const a: AIProvider = "openai_direct";
  const b: AIProvider = "gemini_direct";
  const c: AIProvider = "openrouter";
  assertEquals(a, "openai_direct");
  assertEquals(b, "gemini_direct");
  assertEquals(c, "openrouter");
});

Deno.test("Phase 8.2 #2 — resolveProviderForConfig returns cfg.provider when key is present", () => {
  // Save original env values
  const origOpenAI = Deno.env.get("OPENAI_API_KEY");
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  const origOpenRouter = Deno.env.get("OPENROUTER_API_KEY");
  try {
    // Set fake keys so direct providers are "available"
    Deno.env.set("OPENAI_API_KEY", "sk-test-openai");
    Deno.env.set("GEMINI_API_KEY", "AIza-test-gemini");
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test-openrouter");

    assertEquals(
      resolveProviderForConfig({ provider: "openai_direct", model: "gpt-4.1-mini" }),
      "openai_direct",
    );
    assertEquals(
      resolveProviderForConfig({ provider: "gemini_direct", model: "gemini-2.5-pro" }),
      "gemini_direct",
    );
    assertEquals(
      resolveProviderForConfig({ provider: "openrouter", model: "anthropic/claude-3.5-sonnet" }),
      "openrouter",
    );
  } finally {
    // Restore
    if (origOpenAI === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", origOpenAI);
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
    if (origOpenRouter === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOpenRouter);
  }
});

Deno.test("Phase 8.2 #3 — resolveProviderForConfig auto-downgrades openai_direct → openrouter when OPENAI_API_KEY missing", () => {
  const origOpenAI = Deno.env.get("OPENAI_API_KEY");
  const origOpenRouter = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.delete("OPENAI_API_KEY");
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test-openrouter");

    assertEquals(
      resolveProviderForConfig({ provider: "openai_direct", model: "gpt-4.1-mini" }),
      "openrouter",
      "openai_direct without OPENAI_API_KEY must downgrade to openrouter",
    );
  } finally {
    if (origOpenAI === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", origOpenAI);
    if (origOpenRouter === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOpenRouter);
  }
});

Deno.test("Phase 8.2 #4 — resolveProviderForConfig auto-downgrades gemini_direct → openrouter when GEMINI_API_KEY missing", () => {
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  const origOpenRouter = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.delete("GEMINI_API_KEY");
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test-openrouter");

    assertEquals(
      resolveProviderForConfig({ provider: "gemini_direct", model: "gemini-2.5-pro" }),
      "openrouter",
      "gemini_direct without GEMINI_API_KEY must downgrade to openrouter",
    );
  } finally {
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
    if (origOpenRouter === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOpenRouter);
  }
});

// ─── Tests 5-9: modelForProvider ────────────────────────────────────────────

Deno.test("Phase 8.2 #5 — modelForProvider adds openai/ prefix for openrouter", () => {
  assertEquals(modelForProvider("gpt-4.1-mini", "openrouter"), "openai/gpt-4.1-mini");
  assertEquals(modelForProvider("gpt-5", "openrouter"), "openai/gpt-5");
  assertEquals(modelForProvider("text-embedding-3-small", "openrouter"), "openai/text-embedding-3-small");
});

Deno.test("Phase 8.2 #6 — modelForProvider adds google/ prefix for openrouter", () => {
  assertEquals(modelForProvider("gemini-2.5-pro", "openrouter"), "google/gemini-2.5-pro");
  assertEquals(modelForProvider("gemini-2.5-flash", "openrouter"), "google/gemini-2.5-flash");
});

Deno.test("Phase 8.2 #7 — modelForProvider leaves already-prefixed models unchanged for openrouter", () => {
  assertEquals(modelForProvider("deepseek/deepseek-chat", "openrouter"), "deepseek/deepseek-chat");
  assertEquals(modelForProvider("anthropic/claude-3.5-sonnet", "openrouter"), "anthropic/claude-3.5-sonnet");
  assertEquals(modelForProvider("qwen/qwen-2.5-72b-instruct", "openrouter"), "qwen/qwen-2.5-72b-instruct");
});

Deno.test("Phase 8.2 #8 — modelForProvider strips prefix for openai_direct", () => {
  assertEquals(modelForProvider("gpt-4.1-mini", "openai_direct"), "gpt-4.1-mini");
  assertEquals(modelForProvider("openai/gpt-4.1-mini", "openai_direct"), "gpt-4.1-mini");
});

Deno.test("Phase 8.2 #9 — modelForProvider strips prefix for gemini_direct", () => {
  assertEquals(modelForProvider("gemini-2.5-pro", "gemini_direct"), "gemini-2.5-pro");
  assertEquals(modelForProvider("google/gemini-2.5-pro", "gemini_direct"), "gemini-2.5-pro");
});

// ─── Tests 10-16: resolveEndpoint / resolveStreamEndpoint ───────────────────

Deno.test("Phase 8.2 #10 — resolveEndpoint returns api.openai.com for openai_direct", () => {
  const origOpenAI = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.set("OPENAI_API_KEY", "sk-test");
    const ep = resolveEndpoint("openai_direct", "gpt-4.1-mini");
    assertStringIncludes(ep.url, "api.openai.com");
    assertEquals(ep.authHeader, "Authorization");
    assertEquals(ep.provider, "openai_direct");
  } finally {
    if (origOpenAI === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", origOpenAI);
  }
});

Deno.test("Phase 8.2 #11 — resolveEndpoint returns generativelanguage.googleapis.com for gemini_direct", () => {
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  try {
    Deno.env.set("GEMINI_API_KEY", "AIza-test");
    const ep = resolveEndpoint("gemini_direct", "gemini-2.5-pro");
    assertStringIncludes(ep.url, "generativelanguage.googleapis.com");
    assertStringIncludes(ep.url, "gemini-2.5-pro");
    assertStringIncludes(ep.url, "generateContent");
    assertEquals(ep.authHeader, "x-goog-api-key");
    assertEquals(ep.provider, "gemini_direct");
  } finally {
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
  }
});

Deno.test("Phase 8.2 #12 — resolveEndpoint returns openrouter.ai for openrouter", () => {
  const origOR = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test");
    const ep = resolveEndpoint("openrouter", "anthropic/claude-3.5-sonnet");
    assertStringIncludes(ep.url, "openrouter.ai");
    assertEquals(ep.authHeader, "Authorization");
    assertEquals(ep.provider, "openrouter");
  } finally {
    if (origOR === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOR);
  }
});

Deno.test("Phase 8.2 #13/#14 — resolveEndpoint authHeader per provider", () => {
  const origOpenAI = Deno.env.get("OPENAI_API_KEY");
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  const origOR = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.set("OPENAI_API_KEY", "sk-test");
    Deno.env.set("GEMINI_API_KEY", "AIza-test");
    Deno.env.set("OPENROUTER_API_KEY", "sk-or-test");

    assertEquals(resolveEndpoint("openai_direct", "gpt-4.1-mini").authHeader, "Authorization");
    assertEquals(resolveEndpoint("gemini_direct", "gemini-2.5-pro").authHeader, "x-goog-api-key");
    assertEquals(resolveEndpoint("openrouter", "openai/gpt-4.1-mini").authHeader, "Authorization");
  } finally {
    if (origOpenAI === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", origOpenAI);
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
    if (origOR === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", origOR);
  }
});

Deno.test("Phase 8.2 #15 — resolveStreamEndpoint returns streamGenerateContent for gemini_direct", () => {
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  try {
    Deno.env.set("GEMINI_API_KEY", "AIza-test");
    const ep = resolveStreamEndpoint("gemini_direct", "gemini-2.5-pro");
    assertStringIncludes(ep.url, "streamGenerateContent");
    assertStringIncludes(ep.url, "alt=sse");
    assertEquals(ep.authHeader, "x-goog-api-key");
  } finally {
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", origGemini);
  }
});

Deno.test("Phase 8.2 #16 — resolveStreamEndpoint returns chat/completions for openai_direct", () => {
  const origOpenAI = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.set("OPENAI_API_KEY", "sk-test");
    const ep = resolveStreamEndpoint("openai_direct", "gpt-4.1-mini");
    assertStringIncludes(ep.url, "chat/completions");
    assertEquals(ep.authHeader, "Authorization");
  } finally {
    if (origOpenAI === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", origOpenAI);
  }
});

// ─── Tests 17-23: Gemini adapters ───────────────────────────────────────────

Deno.test("Phase 8.2 #17 — toGeminiRequest converts system messages to systemInstruction", () => {
  const cfg: ModelConfig = {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.2,
    max_tokens: 1000,
    description: "test",
  };
  const messages: RouterMessage[] = [
    { role: "system", content: "You are a legal assistant." },
    { role: "user", content: "What is cassation?" },
  ];
  const body = toGeminiRequest(messages, cfg);
  // systemInstruction should be present
  assert(body.systemInstruction, "systemInstruction present");
  const sysInstr = body.systemInstruction as { parts: Array<{ text: string }> };
  assertStringIncludes(sysInstr.parts[0].text, "legal assistant");
  // contents should NOT include the system message
  const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
  assertEquals(contents.length, 1);
  assertEquals(contents[0].role, "user");
});

Deno.test("Phase 8.2 #18 — toGeminiRequest converts user/assistant messages to contents", () => {
  const cfg: ModelConfig = {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.2,
    max_tokens: 1000,
    description: "test",
  };
  const messages: RouterMessage[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "Help me" },
  ];
  const body = toGeminiRequest(messages, cfg);
  const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
  assertEquals(contents.length, 3);
  assertEquals(contents[0].role, "user");
  assertEquals(contents[1].role, "model"); // assistant → model
  assertEquals(contents[2].role, "user");
  assertEquals(contents[0].parts[0].text, "Hello");
  assertEquals(contents[1].parts[0].text, "Hi there");
});

Deno.test("Phase 8.2 #19 — toGeminiRequest sets generationConfig with temperature + maxOutputTokens", () => {
  const cfg: ModelConfig = {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.15,
    max_tokens: 8000,
    description: "test",
  };
  const body = toGeminiRequest([], cfg);
  const genCfg = body.generationConfig as { temperature: number; maxOutputTokens: number };
  assertEquals(genCfg.temperature, 0.15);
  assertEquals(genCfg.maxOutputTokens, 8000);
});

Deno.test("Phase 8.2 #20 — toGeminiRequest sets responseMimeType when json_mode is true", () => {
  const cfg: ModelConfig = {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0,
    max_tokens: 200,
    json_mode: true,
    description: "test",
  };
  const body = toGeminiRequest([], cfg);
  const genCfg = body.generationConfig as { responseMimeType?: string };
  assertEquals(genCfg.responseMimeType, "application/json");
});

Deno.test("Phase 8.2 #21 — fromGeminiResponse converts candidates → choices[0].message.content", () => {
  const geminiResponse = {
    candidates: [{
      content: {
        parts: [{ text: "Hello " }, { text: "world" }],
        role: "model",
      },
      finishReason: "STOP",
    }],
  };
  const openAiResponse = fromGeminiResponse(geminiResponse);
  const choices = openAiResponse.choices as Array<{ message: { content: string; role: string }; finish_reason: string }>;
  assertEquals(choices.length, 1);
  assertEquals(choices[0].message.content, "Hello world");
  assertEquals(choices[0].message.role, "assistant");
  assertEquals(choices[0].finish_reason, "stop");
});

Deno.test("Phase 8.2 #22 — fromGeminiResponse converts usageMetadata → usage", () => {
  const geminiResponse = {
    candidates: [{ content: { parts: [{ text: "OK" }] } }],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  };
  const openAiResponse = fromGeminiResponse(geminiResponse);
  const usage = openAiResponse.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  assertEquals(usage.prompt_tokens, 10);
  assertEquals(usage.completion_tokens, 5);
  assertEquals(usage.total_tokens, 15);
});

Deno.test("Phase 8.2 #23 — fromGeminiResponse handles empty candidates", () => {
  const geminiResponse = {};
  const openAiResponse = fromGeminiResponse(geminiResponse);
  const choices = openAiResponse.choices as Array<{ message: { content: string } }>;
  assertEquals(choices.length, 1);
  assertEquals(choices[0].message.content, "");
});

// ─── Tests 24-30: MODEL_MAP / ROLE_OVERRIDES coverage ───────────────────────

Deno.test("Phase 8.2 #24 — ModelConfig has required provider field", () => {
  // Type-level: if provider is required, omitting it should fail type-check.
  // We verify by constructing a valid config.
  const cfg: ModelConfig = {
    provider: "openrouter",
    model: "test-model",
    temperature: 0.1,
    max_tokens: 1000,
    description: "test",
  };
  assertEquals(cfg.provider, "openrouter");
});

Deno.test("Phase 8.2 #25 — MODEL_MAP: every entry has provider field", () => {
  const violations: string[] = [];
  for (const [fn, cfg] of Object.entries(MODEL_MAP)) {
    if (!cfg.provider) {
      violations.push(fn);
    }
  }
  assertEquals(violations, [], `Missing provider: ${violations.join(", ")}`);
});

Deno.test("Phase 8.2 #26 — MODEL_MAP: Gemini models use gemini_direct provider", () => {
  const geminiFns = [
    "extract-case-fields",
    "kb-search-assistant",
    "audio-transcribe",
    "legal-practice-import",
    "prompt-armor-repair",
    "ocr-process",
    "kb-scrape-batch",
    "kb-fetch-pdf-content",
  ];
  for (const fn of geminiFns) {
    const cfg = MODEL_MAP[fn];
    assert(cfg, `${fn} exists`);
    assertEquals(cfg.provider, "gemini_direct", `${fn} should use gemini_direct`);
  }
});

Deno.test("Phase 8.2 #27 — MODEL_MAP: OpenAI utility models use openai_direct provider", () => {
  const openaiFns = [
    "legal-practice-enrich",
    "vector-search-rerank",
    "practice-ai-enrich-worker",
  ];
  for (const fn of openaiFns) {
    const cfg = MODEL_MAP[fn];
    assert(cfg, `${fn} exists`);
    assertEquals(cfg.provider, "openai_direct", `${fn} should use openai_direct`);
  }
});

Deno.test("Phase 8.2 #28 — MODEL_MAP: Anthropic models use openrouter provider (no direct)", () => {
  const anthropicFns = [
    "ai-analyze",
    "multi-agent-analyze",
    "generate-complaint",
    "legal-chat",
    "analyze-files-for-complaint",
    "generate-document",
    "admin-ai-chat",
    "map-reduce-summarize",
    "translate-to-armenian",
    "echr-translate",
  ];
  for (const fn of anthropicFns) {
    const cfg = MODEL_MAP[fn];
    assert(cfg, `${fn} exists`);
    assertEquals(cfg.provider, "openrouter", `${fn} should use openrouter (Anthropic has no direct provider)`);
  }
});

Deno.test("Phase 8.2 #29 — ROLE_OVERRIDES: every JSON role uses gemini_direct", () => {
  const jsonRoles = [
    "ai-analyze:precedent_citation",
    "ai-analyze:cross_exam",
    "ai-analyze:deadline_rules",
    "ai-analyze:law_update_summary",
  ];
  for (const role of jsonRoles) {
    const cfg = ROLE_OVERRIDES[role];
    assert(cfg, `${role} exists`);
    assertEquals(cfg.provider, "gemini_direct", `${role} should use gemini_direct`);
  }
});

Deno.test("Phase 8.2 #30 — ROLE_OVERRIDES: draft_deterministic uses openrouter", () => {
  const cfg = ROLE_OVERRIDES["ai-analyze:draft_deterministic"];
  assert(cfg, "draft_deterministic exists");
  assertEquals(cfg.provider, "openrouter");
});

// ─── Tests 31-34: fallback chain contracts ──────────────────────────────────

Deno.test("Phase 8.2 #31 — ProviderFallbackMeta includes provider_original_provider and provider_actual_provider", () => {
  // Type-level: if these fields are missing, TS won't compile.
  const meta: ProviderFallbackMeta = {
    provider_fallback_used: true,
    provider_original_model: "anthropic/claude-3.5-sonnet",
    provider_actual_model: "deepseek/deepseek-chat",
    provider_original_provider: "openrouter",
    provider_actual_provider: "openrouter",
    provider_error_category: "unavailable",
    provider_error_http_status: 404,
    provider_error_message: "No endpoints found",
  };
  assertEquals(meta.provider_original_provider, "openrouter");
  assertEquals(meta.provider_actual_provider, "openrouter");
  assertNotEquals(meta.provider_original_provider, meta.provider_actual_provider === "openrouter" ? "gemini_direct" : "openrouter");
});

Deno.test("Phase 8.2 #32 — legal-chat MODEL_MAP: openrouter primary + openrouter fallback (Anthropic + DeepSeek chain)", () => {
  const cfg = MODEL_MAP["legal-chat"];
  assertEquals(cfg.provider, "openrouter");
  assertEquals(cfg.model, "anthropic/claude-3.5-sonnet");
  assert(cfg.fallback, "legal-chat has fallback");
  assertEquals(cfg.fallback.provider, "openrouter");
  assertEquals(cfg.fallback.model, "deepseek/deepseek-chat");
});

Deno.test("Phase 8.2 #33 — extract-case-fields MODEL_MAP: gemini_direct primary + openrouter fallback", () => {
  const cfg = MODEL_MAP["extract-case-fields"];
  assertEquals(cfg.provider, "gemini_direct");
  assertEquals(cfg.model, "gemini-2.5-pro");
  assert(cfg.fallback, "extract-case-fields has fallback");
  assertEquals(cfg.fallback.provider, "openrouter");
  assertEquals(cfg.fallback.model, "qwen/qwen-2.5-72b-instruct");
});

Deno.test("Phase 8.2 #34 — legal-practice-enrich MODEL_MAP: openai_direct primary + openrouter fallback", () => {
  const cfg = MODEL_MAP["legal-practice-enrich"];
  assertEquals(cfg.provider, "openai_direct");
  assertEquals(cfg.model, "gpt-4.1-mini");
  assert(cfg.fallback, "legal-practice-enrich has fallback");
  assertEquals(cfg.fallback.provider, "openrouter");
  assertEquals(cfg.fallback.model, "qwen/qwen-2.5-72b-instruct");
});

// ─── Tests 35-36: streaming adapter + regression ────────────────────────────

Deno.test("Phase 8.2 #35 — createGeminiToOpenAiSseTransformer is exported from gateway-bypass", async () => {
  const source = await Deno.readTextFile(new URL("./gateway-bypass.ts", import.meta.url));
  assertStringIncludes(source, "createGeminiToOpenAiSseTransformer");
  // Verify it actually constructs OpenAI delta chunks
  assertStringIncludes(source, 'delta: text ? { content: text }');
  assertStringIncludes(source, "data: ${JSON.stringify(openAiChunk)}");
  // Verify it handles [DONE]
  assertStringIncludes(source, 'data: [DONE]');
});

Deno.test("Phase 8.2 #36 — legal-chat still surfaces provider_fallback_meta in pipeline_metadata (regression)", async () => {
  const source = await Deno.readTextFile(new URL("../legal-chat/index.ts", import.meta.url));
  assertStringIncludes(source, "streamResult.provider_fallback_meta");
  assertStringIncludes(source, "provider_fallback_meta:");
  // Phase 8.2: legal-chat must still use callStreamBypass
  assertStringIncludes(source, "callStreamBypass");
  assertStringIncludes(source, 'bypassReason: "streaming"');
});

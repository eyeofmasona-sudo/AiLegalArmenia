/**
 * _shared/openai-router.ts — Centralized AI router for all non-OCR edge functions.
 *
 * MODEL GOVERNANCE (provider-routed):
 * - Claude/Gemini model IDs are routed through OpenRouter by ai-provider.ts.
 * - OpenAI models are used for embeddings and explicitly allowlisted utility roles.
 * - google/gemini-2.5-pro is used for strict JSON-output roles.
 * - google/gemini-2.5-flash / flash-lite are used for cheap utilities.
 * - No silent fallbacks. No hardcoded model strings. model_used always from router.
 *
 * Required env vars:
 *   OPENAI_API_KEY         — required for openai/* models and embeddings
 *   OPENROUTER_API_KEY     — required when ai_provider is openrouter
 *   OPENAI_TIMEOUT_MS      — optional, default 60000
 *   OPENAI_AUDIO_TIMEOUT_MS — optional, default 120000
 *   OPENAI_MAX_RETRIES     — optional, default 2
 */

// ── Model map ────────────────────────────────────────────────────────────────

/**
 * Phase 8.2 — Provider type re-exported from ai-provider.ts for convenience.
 * Available values: "openai_direct" | "gemini_direct" | "openrouter"
 */
export type { AIProvider } from "./ai-provider.ts";
import type { AIProvider } from "./ai-provider.ts";

export interface ModelConfig {
  /**
   * Phase 8.2 — explicit provider for this model.
   *   - "openai_direct": direct OpenAI API (api.openai.com) — needs OPENAI_API_KEY
   *   - "gemini_direct": direct Google Gemini API — needs GEMINI_API_KEY
   *   - "openrouter":    OpenRouter gateway — needs OPENROUTER_API_KEY
   *
   * If the configured direct provider's key is missing, the router
   * auto-downgrades to OpenRouter (see resolveProviderForConfig in ai-provider.ts).
   */
  provider: AIProvider;
  model: string;
  temperature: number;
  max_tokens: number;
  json_mode?: boolean;
  description: string;
  /**
   * Optional fallback model used automatically when the primary model is
   * region-blocked (403), deprecated (404), or returns 5xx.
   * Quota (402) and rate-limit (429) errors do NOT trigger fallback — those
   * are billing/capacity issues that affect the fallback model too.
   *
   * Phase 8.1 — AI Provider Routing Production Hardening.
   */
  fallback?: {
    provider: AIProvider;
    model: string;
    temperature: number;
    max_tokens: number;
    json_mode?: boolean;
    reason?: string;
  };
}

/**
 * Metadata returned with every AI call when a fallback was used.
 * Phase 8.1 contract — never silently downgrade legal quality in production.
 */
export interface ProviderFallbackMeta {
  provider_fallback_used: true;
  provider_original_model: string;
  provider_actual_model: string;
  provider_original_provider: AIProvider;
  provider_actual_provider: AIProvider;
  provider_error_category: ProviderErrorCategory;
  provider_error_http_status: number;
  provider_error_message: string;
}

/** Governance metadata returned with every AI call */
export interface GovernanceMeta {
  role: string;
  model_used: string;
  temperature_used: number;
  max_tokens_used: number;
}

/**
 * Strict per-function model assignment.
 * Legal reasoning uses Claude through OpenRouter; Gemini Pro is reserved for strict JSON.
 */
export const MODEL_MAP: Record<string, ModelConfig> = {
  // ── Primary legal reasoning ───────────────────────────────────────────────
  // Phase 8.2: Anthropic has no direct provider integration (no official Deno-
  // compatible API client for Anthropic in this codebase). All Anthropic
  // primary models go through OpenRouter. OpenRouter is region-blocked for
  // Anthropic from Supabase ap-northeast-2 edge runtime, so every Anthropic
  // primary will fall back to the openrouter fallback (DeepSeek V3).
  //
  // To restore Claude quality: add an Anthropic direct provider in ai-provider.ts.
  // Until then, legal-reasoning uses DeepSeek V3 (via the fallback chain).
  "ai-analyze": {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    temperature: 0.15,
    max_tokens: 14000,
    description: "Case analysis (Claude Sonnet 4 via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.15,
      max_tokens: 14000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
  "multi-agent-analyze": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.2,
    max_tokens: 16000,
    description: "Multi-agent analysis (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.2,
      max_tokens: 16000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
  "generate-complaint": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.1,
    max_tokens: 14000,
    description: "Complaint drafting (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.1,
      max_tokens: 14000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
  "legal-chat": {
    // Phase 8.2: primary restored to Claude 3.5 Sonnet via OpenRouter.
    // Falls back to DeepSeek V3 when OpenRouter returns 403/404/5xx for Claude.
    // Fallback metadata is surfaced in the SSE pipeline_metadata event.
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.2,
    max_tokens: 16000,
    description: "Legal chat (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.2,
      max_tokens: 8000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
  "analyze-files-for-complaint": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.2,
    max_tokens: 16000,
    description: "File analysis (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.2,
      max_tokens: 16000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
  "generate-document": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.2,
    max_tokens: 10000,
    description: "Documents (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.2,
      max_tokens: 10000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },

  // ── Strict JSON ───────────────────────────────────────────────────────────
  // Phase 8.2: Gemini Pro via direct Gemini API (bypasses OpenRouter region
  // block). Falls back to Qwen 72B via OpenRouter if direct Gemini fails.
  "extract-case-fields": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.15,
    max_tokens: 16000,
    description: "Extract fields (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.15,
      max_tokens: 16000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },
  "kb-search-assistant": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.2,
    max_tokens: 200,
    json_mode: true,
    description: "KB keywords JSON (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      max_tokens: 200,
      json_mode: true,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },

  // ── Utilities ─────────────────────────────────────────────────────────────
  "audio-transcribe": {
    provider: "gemini_direct",
    model: "gemini-2.5-flash",
    temperature: 0.1,
    max_tokens: 16000,
    description: "Transcription (Gemini Flash direct, fallback Llama 70B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      temperature: 0.1,
      max_tokens: 16000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },
  "echr-translate": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.1,
    max_tokens: 8000,
    description: "ECHR translate (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.1,
      max_tokens: 8000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
  "legal-practice-enrich": {
    provider: "openai_direct",
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 16000,
    description: "Enrich practice (GPT-4.1 mini direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      max_tokens: 16000,
      reason: "OpenAI direct API failure or missing OPENAI_API_KEY",
    },
  },
  "vector-search-rerank": {
    provider: "openai_direct",
    model: "gpt-4.1-mini",
    temperature: 0.1,
    max_tokens: 1000,
    description: "Rerank (GPT-4.1 mini direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.1,
      max_tokens: 1000,
      reason: "OpenAI direct API failure or missing OPENAI_API_KEY",
    },
  },

  // ── Bypass-only utilities ─────────────────────────────────────────────────
  // Phase 8.2: multimodal functions stay on Gemini direct (no fallback — no
  // region-safe vision-capable fallback model exists).
  "ocr-process": {
    provider: "gemini_direct",
    model: "gemini-2.5-flash",
    temperature: 0.1,
    max_tokens: 8000,
    description: "OCR vision (Gemini Flash direct, bypass:multimodal)",
    // No fallback — multimodal; only Gemini Flash supports vision in this set.
  },
  "kb-scrape-batch": {
    provider: "gemini_direct",
    model: "gemini-2.5-flash",
    temperature: 0.1,
    max_tokens: 16000,
    description: "KB PDF scrape (Gemini Flash direct, bypass:multimodal)",
    // No fallback — multimodal.
  },
  "kb-fetch-pdf-content": {
    provider: "gemini_direct",
    model: "gemini-2.5-flash",
    temperature: 0.1,
    max_tokens: 16000,
    description: "KB fetch PDF (Gemini Flash direct, bypass:multimodal)",
    // No fallback — multimodal.
  },
  "legal-practice-import": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0,
    max_tokens: 8000,
    description: "Practice import extract (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0,
      max_tokens: 8000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },
  "prompt-armor-repair": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0,
    max_tokens: 8000,
    description: "JSON repair (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0,
      max_tokens: 8000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },

  // ── Embeddings (OpenAI only — always direct, no gateway) ──────────────────
  "generate-embeddings": {
    provider: "openai_direct",
    model: "openai/text-embedding-3-small",
    temperature: 0,
    max_tokens: 0,
    description: "Embeddings (OpenAI direct)",
    // No fallback — embeddings have a different runtime path (embeddings-generate
    // edge function calls the VPS embedding server directly, not OpenAI).
  },

  // ── Admin utilities ─────────────────────────────────────────────────────
  "admin-ai-chat": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.3,
    max_tokens: 16000,
    description: "Admin AI chat (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.3,
      max_tokens: 16000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },

  // ── Worker aliases ────────────────────────────────────────────────────────
  "practice-ai-enrich-worker": {
    provider: "openai_direct",
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 16000,
    description: "Enrich practice worker (GPT-4.1 mini direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      max_tokens: 16000,
      reason: "OpenAI direct API failure or missing OPENAI_API_KEY",
    },
  },

  // ── Map-Reduce summarizer ─────────────────────────────────────────────────
  "map-reduce-summarize": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.1,
    max_tokens: 4000,
    description: "Map-Reduce chunk summarizer (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.1,
      max_tokens: 4000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },

  // ── Translation ───────────────────────────────────────────────────────────
  "translate-to-armenian": {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    temperature: 0.1,
    max_tokens: 4096,
    description: "Legal translation to Armenian (Claude 3.5 Sonnet via OpenRouter, fallback DeepSeek V3)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0.1,
      max_tokens: 4096,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
};

/**
 * Role-specific model overrides for ai-analyze engines.
 *
 * Phase 8.1: exported so tests / dashboards can introspect the configured role
 * models and fallbacks without invoking getModelConfig().
 */
export const ROLE_OVERRIDES: Record<string, Partial<ModelConfig>> = {
  // ── Reasoning roles (inherit base provider/model from MODEL_MAP) ─────────
  "ai-analyze:strategy_builder": { description: "Strategy builder" },
  "ai-analyze:risk_factors": { description: "Risk factors" },
  "ai-analyze:evidence_weakness": { description: "Evidence weakness" },
  "ai-analyze:hallucination_audit": { description: "Hallucination audit" },
  "ai-analyze:legal_position_comparator": { description: "Comparator" },
  // ── Deterministic draft (temp=0) ───────────────────────────────────────────
  "ai-analyze:draft_deterministic": {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    temperature: 0,
    max_tokens: 14000,
    description: "Deterministic draft (Claude Sonnet 4 temp=0 via OpenRouter, fallback DeepSeek V3 temp=0)",
    fallback: {
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      temperature: 0,
      max_tokens: 14000,
      reason: "Claude region-blocked from Supabase ap-northeast-2 edge runtime",
    },
  },
  // ── JSON roles (Gemini Pro direct) ─────────────────────────────────────
  // Phase 8.2: all Gemini Pro JSON roles use direct Gemini API.
  "ai-analyze:precedent_citation": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.2,
    max_tokens: 8000,
    description: "Precedent JSON (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      max_tokens: 8000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },
  "ai-analyze:cross_exam": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.2,
    max_tokens: 8000,
    description: "Cross-exam JSON (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      max_tokens: 8000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },
  "ai-analyze:deadline_rules": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.2,
    max_tokens: 8000,
    description: "Deadlines JSON (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      max_tokens: 8000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },
  "ai-analyze:law_update_summary": {
    provider: "gemini_direct",
    model: "gemini-2.5-pro",
    temperature: 0.2,
    max_tokens: 8000,
    description: "Law update JSON (Gemini 2.5 Pro direct, fallback Qwen 72B via OpenRouter)",
    fallback: {
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      max_tokens: 8000,
      reason: "Gemini direct API failure or missing GEMINI_API_KEY",
    },
  },
};

// ── Governance constants & allowlists ────────────────────────────────────────

const MAX_TEMPERATURE = 0.3;
const MAX_TOKENS_CAP = 16384;

/** OpenAI chat models allowed ONLY for these roleLabels/functionNames (kept for future if we switch back) */
const OPENAI_CHAT_ALLOWLIST = new Set([
  "generate-complaint",
  "multi-agent-analyze",
  "legal-chat",
  "analyze-files-for-complaint",
  "generate-document",
  "ai-analyze",
  "ai-analyze:strategy_builder",
  "ai-analyze:risk_factors",
  "ai-analyze:evidence_weakness",
  "ai-analyze:hallucination_audit",
  "ai-analyze:legal_position_comparator",
  "ai-analyze:draft_deterministic",
  "extract-case-fields",
  "admin-ai-chat",
]);

/** OpenAI embedding models allowed ONLY for these functionNames */
const OPENAI_EMBEDDING_ALLOWLIST = new Set([
  "generate-embeddings",
]);

/** Roles that use strict JSON output */
const STRICT_JSON_ROLES = new Set([
  "ai-analyze:precedent_citation",
  "ai-analyze:cross_exam",
  "ai-analyze:deadline_rules",
  "ai-analyze:law_update_summary",
]);

/** Functions that use callJSON */
const STRICT_JSON_FUNCTIONS = new Set([
  "kb-search-assistant",
]);

/** Combined set of all roleLabels/functionNames allowed to use callJSON */
const CALLJSON_ALLOWED = new Set([
  ...STRICT_JSON_ROLES,
  ...STRICT_JSON_FUNCTIONS,
]);

/**
 * Governance-enforced model config resolution.
 */
export function getModelConfig(functionName: string, role?: string): ModelConfig {
  const roleLabel = role ? `${functionName}:${role}` : functionName;

  if (role) {
    const overrideKey = `${functionName}:${role}`;
    const override = ROLE_OVERRIDES[overrideKey];
    if (!override) {
      throw new Error(
        `[openai-router] Undefined role "${role}" for function "${functionName}". ` +
          `Register it in ROLE_OVERRIDES or check the role name.`
      );
    }
    const base = MODEL_MAP[functionName];
    if (!base) {
      throw new Error(
        `[openai-router] No model config for function "${functionName}".`
      );
    }
    const merged = { ...base, ...override } as ModelConfig;
    return enforceGovernance(merged, roleLabel, functionName);
  }

  const cfg = MODEL_MAP[functionName];
  if (!cfg) {
    // Audit-log the missing key for observability
    console.error(
      `[openai-router] GOVERNANCE VIOLATION: No MODEL_MAP entry for "${functionName}". ` +
      `Available keys: ${Object.keys(MODEL_MAP).join(", ")}`
    );
    throw new Error(
      `[openai-router] No model config for function "${functionName}". ` +
      `Register it in MODEL_MAP before calling getModelConfig().`
    );
  }
  return enforceGovernance(cfg, roleLabel, functionName);
}

export function buildGovernanceMeta(cfg: ModelConfig, roleLabel: string): GovernanceMeta {
  return {
    role: roleLabel,
    model_used: cfg.model,
    temperature_used: cfg.temperature,
    max_tokens_used: cfg.max_tokens,
  };
}

/**
 * Allowlist-based governance enforcement:
 * - openai/text-embedding-*: allowed ONLY by functionName (not roleLabel).
 * - openai/* chat: allowed ONLY if roleLabel is in OPENAI_CHAT_ALLOWLIST.
 * - STRICT_JSON_ROLES must resolve to gemini-2.5-pro (via gemini_direct).
 * - Temperature > 0.3 or max_tokens > 16384: STRICT THROW.
 *
 * Phase 8.2: with provider field now in ModelConfig, model names are stored
 * in canonical form (without vendor prefix for direct providers). The
 * openai/ prefix check is now done against either the prefixed name OR the
 * provider + bare name combination.
 */
function enforceGovernance(cfg: ModelConfig, roleLabel: string, functionName: string): ModelConfig {
  // ── OpenAI allowlist checks ────────────────────────────────────────────────
  // Phase 8.2: detect OpenAI chat/embedding models either by old-style prefix
  // OR by provider=openai_direct with bare model name.
  const isOpenAIEmbedding =
    cfg.model.startsWith("openai/text-embedding-") ||
    (cfg.provider === "openai_direct" && cfg.model.startsWith("text-embedding-"));
  const isOpenAIChat =
    (cfg.model.startsWith("openai/") && !isOpenAIEmbedding) ||
    (cfg.provider === "openai_direct" && !cfg.model.startsWith("text-embedding-"));

  if (isOpenAIEmbedding) {
    if (!OPENAI_EMBEDDING_ALLOWLIST.has(functionName)) {
      throw new Error(
        `[openai-router] GOVERNANCE VIOLATION: OpenAI embedding model "${cfg.model}" ` +
          `is not allowed for function "${functionName}". Allowed only for: ${[...OPENAI_EMBEDDING_ALLOWLIST].join(", ")}.`
      );
    }
    return cfg;
  }
  if (isOpenAIChat) {
    if (!OPENAI_CHAT_ALLOWLIST.has(roleLabel)) {
      throw new Error(
        `[openai-router] GOVERNANCE VIOLATION: OpenAI chat model "${cfg.model}" ` +
          `is not allowed for "${roleLabel}". Add to OPENAI_CHAT_ALLOWLIST if intended.`
      );
    }
  }

  // ── Strict JSON roles are enforced by MODEL_MAP/ROLE_OVERRIDES and callJSON gates. ──

  // ── Parameter caps ─────────────────────────────────────────────────────────
  if (cfg.temperature > MAX_TEMPERATURE) {
    throw new Error(
      `[openai-router] GOVERNANCE VIOLATION: temperature ${cfg.temperature} exceeds cap ${MAX_TEMPERATURE} for "${roleLabel}".`
    );
  }
  if (cfg.max_tokens > MAX_TOKENS_CAP) {
    throw new Error(
      `[openai-router] GOVERNANCE VIOLATION: max_tokens ${cfg.max_tokens} exceeds cap ${MAX_TOKENS_CAP} for "${roleLabel}".`
    );
  }

  return cfg;
}

// ── LEGAL safety header (prepended to all legal reasoning functions) ─────────

const LEGAL_REASONING_FNS = new Set([
  "ai-analyze",
  "multi-agent-analyze",
  "legal-chat",
  "generate-complaint",
  "analyze-files-for-complaint",
  "generate-document",
]);

const JSON_FNS = new Set(["extract-case-fields", "kb-search-assistant"]);

export const LEGAL_SAFETY_HEADER = `RULES:
- Do not invent laws, articles, case numbers, or quotations.
- Use only provided context for citations; if missing, say so.
- If facts are insufficient, list missing facts explicitly.
- Keep output structured and conservative.`;

export const JSON_SAFETY_HEADER = `Return ONLY valid JSON matching the schema. No extra keys. No commentary. Unknown fields must be null.`;

function prependSafetyHeader(
  functionName: string,
  messages: RouterMessage[]
): RouterMessage[] {
  const header = LEGAL_REASONING_FNS.has(functionName)
    ? LEGAL_SAFETY_HEADER
    : JSON_FNS.has(functionName)
      ? JSON_SAFETY_HEADER
      : null;

  if (!header) return messages;

  return messages.map((m, idx) => {
    if (idx === 0 && m.role === "system") {
      return { ...m, content: header + "\n\n" + m.content };
    }
    return m;
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface RouterMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown[]; // allow multimodal content arrays
}

export interface RouterCallOptions {
  /** Override timeout in ms (falls back to env var or default) */
  timeoutMs?: number;
}

export interface TextResult {
  text: string;
  model_used: string;
  latency_ms: number;
  request_id: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  governance: GovernanceMeta;
  /** Present ONLY when a provider fallback was used (Phase 8.1). */
  provider_fallback_meta?: ProviderFallbackMeta;
}

export interface JSONResult<T = unknown> {
  json: T;
  model_used: string;
  latency_ms: number;
  request_id: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  governance: GovernanceMeta;
  /** Present ONLY when a provider fallback was used (Phase 8.1). */
  provider_fallback_meta?: ProviderFallbackMeta;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

import {
  getAIProvider,
  resolveEndpoint,
  resolveProviderForConfig,
  modelForProvider,
  type AIProvider as AIProviderType,
} from "./ai-provider.ts";
// Phase 8.1: converted from dynamic import for reliable Supabase bundler detection.
import { generateEmbeddings } from "./embeddings.ts";

// ── Gemini adapter (Phase 8.2) ──────────────────────────────────────────────
// Gemini's API uses a completely different request/response format than OpenAI.
// These adapters convert between the two so the rest of openai-router can
// treat all providers uniformly (callText / callJSON don't need to know about
// Gemini's contents/parts/systemInstruction structure).

/**
 * Convert OpenAI-style messages + ModelConfig into a Gemini generateContent
 * request body.
 *
 * Mapping:
 *   - system messages  → systemInstruction.parts[].text
 *   - user messages    → contents[{role:"user",     parts:[{text}]}]
 *   - assistant msgs   → contents[{role:"model",    parts:[{text}]}]
 *   - temperature      → generationConfig.temperature
 *   - max_tokens       → generationConfig.maxOutputTokens
 *   - json_mode        → generationConfig.responseMimeType = "application/json"
 */
export function toGeminiRequest(
  messages: RouterMessage[],
  cfg: ModelConfig,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemText = systemMessages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n\n");

  // Convert user/assistant messages → contents
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: typeof m.content === "string" ? m.content : "" }],
    }));

  const generationConfig: Record<string, unknown> = {
    temperature: cfg.temperature,
    maxOutputTokens: cfg.max_tokens,
  };
  if (cfg.json_mode) {
    generationConfig.responseMimeType = "application/json";
  }

  const body: Record<string, unknown> = { contents, generationConfig };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  return body;
}

/**
 * Convert a Gemini generateContent response into an OpenAI-format response
 * so the rest of openai-router can consume it uniformly.
 *
 * Mapping:
 *   - candidates[0].content.parts[].text  → choices[0].message.content
 *   - candidates[0].content.role          → choices[0].message.role ("assistant")
 *   - usageMetadata.promptTokenCount      → usage.prompt_tokens
 *   - usageMetadata.candidatesTokenCount → usage.completion_tokens
 *   - usageMetadata.totalTokenCount       → usage.total_tokens
 */
export function fromGeminiResponse(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const candidates = data.candidates as Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }> | undefined;

  const text =
    candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";

  const usageMetadata = data.usageMetadata as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  } | undefined;

  const choices = [{
    index: 0,
    message: { role: "assistant", content: text },
    finish_reason: "stop",
  }];

  const result: Record<string, unknown> = { choices };
  if (usageMetadata) {
    result.usage = {
      prompt_tokens: usageMetadata.promptTokenCount ?? 0,
      completion_tokens: usageMetadata.candidatesTokenCount ?? 0,
      total_tokens: usageMetadata.totalTokenCount ?? 0,
    };
  }
  return result;
}

/**
 * Phase 8.2 — Build a provider-specific request body from a unified
 * OpenAI-format body + ModelConfig.
 *
 *   - gemini_direct: convert to Gemini format via toGeminiRequest
 *   - openai_direct / openrouter: keep OpenAI format (just ensure model name is correct)
 *
 * The returned body is what gets sent to the provider's API.
 */
function buildProviderRequestBody(
  cfg: ModelConfig,
  messages: RouterMessage[],
  provider: AIProvider,
): Record<string, unknown> {
  if (provider === "gemini_direct") {
    return toGeminiRequest(messages, cfg);
  }
  // openai_direct or openrouter — use OpenAI format
  return buildRequestBody(cfg, messages);
}

/**
 * Classify a non-OK HTTP response from the AI provider.
 * Phase 8.1 — used to decide whether to trigger a model fallback.
 *
 * Categories:
 *   - region_blocked  : 403 with "region" in message → trigger fallback
 *   - unavailable     : 404 "No endpoints found"     → trigger fallback
 *   - server_error    : 5xx                          → trigger fallback (if cfg.fallback set)
 *   - quota           : 402                          → DO NOT trigger fallback (billing issue)
 *   - rate_limit      : 429                          → DO NOT trigger fallback (capacity issue)
 *   - unknown         : anything else                → DO NOT trigger fallback (safer to surface)
 */
export type ProviderErrorCategory =
  | "region_blocked"
  | "unavailable"
  | "server_error"
  | "quota"
  | "rate_limit"
  | "unknown";

export interface ProviderErrorInfo {
  category: ProviderErrorCategory;
  http_status: number;
  message: string;
}

/**
 * Inspect a Response object (already known to be !ok) and classify the error.
 */
async function classifyProviderError(response: Response): Promise<ProviderErrorInfo> {
  const http_status = response.status;
  let message = "";
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? parsed?.message ?? text;
    } catch {
      message = text;
    }
  } catch {
    message = "";
  }
  message = (message || "").slice(0, 200);

  let category: ProviderErrorCategory;
  if (http_status === 403 && /region|not available in your region/i.test(message)) {
    category = "region_blocked";
  } else if (http_status === 404) {
    category = "unavailable";
  } else if (http_status >= 500) {
    category = "server_error";
  } else if (http_status === 402) {
    category = "quota";
  } else if (http_status === 429) {
    category = "rate_limit";
  } else {
    category = "unknown";
  }
  return { category, http_status, message };
}

/**
 * Whether a given error category should trigger an automatic fallback.
 *
 * Phase 8.1 policy: fallback ONLY on infrastructure/region issues, never on billing.
 *
 * Phase 8.2 update: rate_limit (429) and quota (402) errors from a DIRECT
 * provider (openai_direct / gemini_direct) SHOULD trigger fallback to
 * openrouter, because openrouter has its own separate quota/billing. The
 * original Phase 8.1 rule (no fallback on 402/429) was correct for the case
 * where both primary and fallback share the same OpenRouter account, but
 * when the primary is a direct provider (different account/billing), falling
 * back to openrouter is safe.
 *
 * Implementation: we expose two variants:
 *   - shouldFallback(category) — original Phase 8.1 policy (used by openrouter-only fallbacks)
 *   - shouldFallbackForDirectProvider(category) — Phase 8.2 expanded policy
 *     (used when cfg.provider is openai_direct or gemini_direct and fallback
 *     is openrouter with a different account)
 */
export function shouldFallback(category: ProviderErrorCategory): boolean {
  return category === "region_blocked" || category === "unavailable" || category === "server_error";
}

/**
 * Phase 8.2 — Expanded fallback policy for direct-provider primary models.
 * When primary is openai_direct / gemini_direct and fallback is openrouter,
 * quota (402) and rate_limit (429) errors should ALSO trigger fallback,
 * because the fallback provider has a separate billing account.
 */
export function shouldFallbackForDirectProvider(category: ProviderErrorCategory): boolean {
  // All Phase 8.1 categories PLUS quota and rate_limit
  return (
    category === "region_blocked" ||
    category === "unavailable" ||
    category === "server_error" ||
    category === "quota" ||
    category === "rate_limit"
  );
}

/**
 * Phase 8.2 — Decide which shouldFallback policy to apply based on the
 * primary provider and the fallback provider.
 *
 *   - If primary is openai_direct / gemini_direct AND fallback is openrouter
 *     (different account) → use expanded policy (allows fallback on 402/429)
 *   - Otherwise → use original policy (402/429 affect both providers equally)
 */
function shouldFallbackForConfig(
  cfg: ModelConfig,
  category: ProviderErrorCategory,
): boolean {
  if (!cfg.fallback) return false;
  const primaryIsDirect =
    cfg.provider === "openai_direct" || cfg.provider === "gemini_direct";
  const fallbackIsOpenRouter = cfg.fallback.provider === "openrouter";
  if (primaryIsDirect && fallbackIsOpenRouter) {
    return shouldFallbackForDirectProvider(category);
  }
  return shouldFallback(category);
}

function defaultTimeout(isAudio: boolean): number {
  if (isAudio) {
    return parseInt(Deno.env.get("OPENAI_AUDIO_TIMEOUT_MS") ?? "120000", 10);
  }
  return parseInt(Deno.env.get("OPENAI_TIMEOUT_MS") ?? "300000", 10);
}

function maxRetries(): number {
  return parseInt(Deno.env.get("OPENAI_MAX_RETRIES") ?? "1", 10);
}

function newRequestId(): string {
  return crypto.randomUUID();
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Phase 8.1 — Error thrown by fetchWithRetry when the provider returns a
 * non-OK status that we can classify (region_blocked, unavailable, server_error,
 * quota, rate_limit). Carries the full ProviderErrorInfo so callers (callText /
 * callJSON) can decide whether to invoke a fallback model.
 */
export class ProviderHttpError extends Error {
  readonly info: ProviderErrorInfo;
  constructor(info: ProviderErrorInfo) {
    const msg = `AI provider ${info.http_status} [${info.category}]: ${info.message}`;
    super(msg);
    this.name = "ProviderHttpError";
    this.info = info;
    Object.assign(this, { status: info.http_status });
  }
}

/**
 * Core fetch with retries + exponential backoff + jitter.
 * Logs metadata only — never logs user content.
 *
 * Phase 8.1: throws ProviderHttpError on non-OK responses (instead of generic
 * Error), so callers can decide whether to fall back to an alternate model.
 * 429 / 402 errors still preserve their `status` property for backward compat.
 *
 * Phase 8.2: now takes a `cfg` (ModelConfig) instead of just a `body`, so it
 * can resolve the correct provider from cfg.provider and use the Gemini adapter
 * when needed. If cfg.provider is "openai_direct" or "gemini_direct" but the
 * corresponding API key is missing, auto-downgrades to OpenRouter (transparent
 * to the caller — the rest of the call flow doesn't need to know).
 */
async function fetchWithRetry(
  functionName: string,
  requestId: string,
  cfg: ModelConfig,
  messages: RouterMessage[],
  timeoutMs: number
): Promise<{ data: Record<string, unknown>; latency_ms: number }> {
  // Phase 8.2: resolve provider from cfg (auto-downgrade if direct key missing)
  const resolvedProvider = resolveProviderForConfig(cfg);
  const endpoint = resolveEndpoint(resolvedProvider, cfg.model, functionName);

  // Build provider-specific request body
  // For openrouter, the model name needs the vendor prefix
  const modelForApi = resolvedProvider === "openrouter"
    ? modelForProvider(cfg.model, "openrouter")
    : endpoint.modelForApi;

  // Build the appropriate request body for the provider
  const body = buildProviderRequestBody(cfg, messages, resolvedProvider);

  const max = maxRetries();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= max; attempt++) {
    const t0 = Date.now();

    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Build headers based on provider's auth scheme
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (endpoint.authHeader === "x-goog-api-key") {
        // Gemini direct API uses x-goog-api-key header (no Bearer prefix)
        headers["x-goog-api-key"] = endpoint.apiKey;
      } else {
        // OpenAI / OpenRouter use Authorization: Bearer
        headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
      }

      response = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);
    } catch (fetchErr) {
      const latency_ms = Date.now() - t0;
      const errClass =
        fetchErr instanceof Error && fetchErr.name === "AbortError"
          ? "TIMEOUT"
          : "NETWORK_ERROR";

      console.error(
        JSON.stringify({
          request_id: requestId,
          function_name: functionName,
          model_used: cfg.model,
          provider: resolvedProvider,
          attempt,
          latency_ms,
          error_class: errClass,
        })
      );

      lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));

      if (attempt < max) {
        const backoff = Math.pow(2, attempt) * 500 + Math.random() * 300;
        await sleep(backoff);
        continue;
      }
      throw lastError;
    }

    const latency_ms = Date.now() - t0;

    // Log metadata only
    console.log(
      JSON.stringify({
        request_id: requestId,
        function_name: functionName,
        model_used: cfg.model,
        provider: resolvedProvider,
        attempt,
        status: response.status,
        latency_ms,
      })
    );

    if (!response.ok) {
      if (isRetryable(response.status) && attempt < max) {
        const backoff = Math.pow(2, attempt) * 500 + Math.random() * 300;
        await sleep(backoff);
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }

      // Classify the error and throw ProviderHttpError so callers can fallback.
      const info = await classifyProviderError(response);
      throw new ProviderHttpError(info);
    }

    // Safely parse response body — guard against empty/truncated responses
    const responseText = await response.text();
    if (!responseText || responseText.trim().length === 0) {
      throw new Error(`AI provider returned empty response body (status ${response.status})`);
    }
    let rawData: Record<string, unknown>;
    try {
      rawData = JSON.parse(responseText) as Record<string, unknown>;
    } catch (parseErr) {
      console.error(
        JSON.stringify({
          request_id: requestId,
          function_name: functionName,
          error: "JSON parse failed",
          body_preview: responseText.substring(0, 200),
        })
      );
      throw new Error(`AI provider returned invalid JSON: ${(parseErr as Error).message}`);
    }

    // Phase 8.2: convert Gemini response to OpenAI format so callers can treat it uniformly
    const data = resolvedProvider === "gemini_direct"
      ? fromGeminiResponse(rawData)
      : rawData;

    // Log token usage
    const usage = data.usage as
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      | undefined;
    if (usage) {
      console.log(
        JSON.stringify({
          request_id: requestId,
          function_name: functionName,
          model_used: cfg.model,
          provider: resolvedProvider,
          token_usage: usage,
        })
      );
    }

    return { data, latency_ms };
  }

  throw lastError ?? new Error("[openai-router] Max retries exceeded");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a clean OpenAI-format request body for the configured model.
 * Provider-aware parameter rules (Phase 8.2):
 *   - openai_direct with gpt-5* model: use max_completion_tokens, omit temperature
 *   - openai_direct with other models: use temperature + max_tokens
 *   - openrouter with openai/gpt-5*:  use max_completion_tokens, omit temperature
 *   - all other models:               use temperature + max_tokens
 *
 * NOTE: This function is only called for openai_direct / openrouter providers.
 * For gemini_direct, buildProviderRequestBody() calls toGeminiRequest() instead.
 */
function buildRequestBody(
  cfg: ModelConfig,
  messages: RouterMessage[]
): Record<string, unknown> {
  // Detect GPT-5 family — they need max_completion_tokens instead of max_tokens
  // and don't accept a temperature parameter.
  const isGPT5 =
    cfg.provider === "openai_direct"
      ? cfg.model.startsWith("gpt-5")
      : cfg.model.startsWith("openai/gpt-5");
  if (isGPT5) {
    return {
      model: cfg.model,
      max_completion_tokens: cfg.max_tokens,
      messages,
    };
  }
  return {
    model: cfg.model,
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    messages,
  };
}

/**
 * callText — Standard text completion (streaming disabled, waits for full response).
 *
 * Phase 8.1: if the primary model fails with a fallback-eligible error
 * (region_blocked, unavailable, server_error) AND `cfg.fallback` is defined,
 * automatically retries with the fallback model and returns
 * `provider_fallback_meta` so the caller can surface the downgrade to the user.
 *
 * Phase 8.2: cfg.provider now determines the routing — openai_direct uses
 * api.openai.com, gemini_direct uses the Gemini API (with adapter), openrouter
 * uses openrouter.ai. If the direct provider's key is missing, auto-downgrades
 * to openrouter transparently.
 */
export async function callText(
  functionName: string,
  messages: RouterMessage[],
  options: RouterCallOptions & { role?: string } = {}
): Promise<TextResult> {
  const roleLabel = options.role ? `${functionName}:${options.role}` : functionName;

  // Strict JSON roles MUST use callJSON, not callText
  if (STRICT_JSON_ROLES.has(roleLabel)) {
    throw new Error(
      `[openai-router] GOVERNANCE VIOLATION: "${roleLabel}" is a strict JSON role and MUST use callJSON, not callText.`
    );
  }

  const cfg = getModelConfig(functionName, options.role);
  const governance = buildGovernanceMeta(cfg, roleLabel);
  const requestId = newRequestId();
  const safeMessages = prependSafetyHeader(functionName, messages);
  const timeoutMs = options.timeoutMs ?? defaultTimeout(false);

  try {
    const { data, latency_ms } = await fetchWithRetry(
      functionName,
      requestId,
      cfg,
      safeMessages,
      timeoutMs
    );

    const choices = data.choices as Array<{ message: { content: string } }>;
    const text = choices?.[0]?.message?.content ?? "";
    const usage = data.usage as TextResult["usage"];

    return { text, model_used: cfg.model, latency_ms, request_id: requestId, usage, governance };
  } catch (err) {
    // Phase 8.1: try fallback if eligible
    const fallbackMeta = maybeUseFallback(err, cfg);
    if (!fallbackMeta) throw err;

    const fallbackCfg: ModelConfig = {
      ...cfg,
      provider: fallbackMeta.provider_actual_provider,
      model: fallbackMeta.provider_actual_model,
      temperature: cfg.fallback?.temperature ?? cfg.temperature,
      max_tokens: cfg.fallback?.max_tokens ?? cfg.max_tokens,
      json_mode: cfg.fallback?.json_mode ?? cfg.json_mode,
    };
    const { data, latency_ms } = await fetchWithRetry(
      functionName,
      requestId,
      fallbackCfg,
      safeMessages,
      timeoutMs
    );

    const choices = data.choices as Array<{ message: { content: string } }>;
    const text = choices?.[0]?.message?.content ?? "";
    const usage = data.usage as TextResult["usage"];
    const fallbackGovernance = buildGovernanceMeta(fallbackCfg, roleLabel);

    console.warn(
      JSON.stringify({
        request_id: requestId,
        function_name: functionName,
        role_label: roleLabel,
        provider_fallback_used: true,
        provider_original_model: fallbackMeta.provider_original_model,
        provider_actual_model: fallbackMeta.provider_actual_model,
        provider_original_provider: fallbackMeta.provider_original_provider,
        provider_actual_provider: fallbackMeta.provider_actual_provider,
        provider_error_category: fallbackMeta.provider_error_category,
        provider_error_http_status: fallbackMeta.provider_error_http_status,
      })
    );

    return {
      text,
      model_used: fallbackCfg.model,
      latency_ms,
      request_id: requestId,
      usage,
      governance: fallbackGovernance,
      provider_fallback_meta: fallbackMeta,
    };
  }
}

/**
 * Phase 8.1 — Shared helper for callText / callJSON: if `err` is a
 * ProviderHttpError AND the resolved ModelConfig has a `fallback` defined AND
 * the error category is fallback-eligible, return a ProviderFallbackMeta
 * describing the fallback to use. Otherwise return null (caller rethrows).
 *
 * This helper never makes a network call — it just decides whether to fall back.
 *
 * Phase 8.2: now includes provider_original_provider and provider_actual_provider
 * in the returned meta (so callers can see e.g. "fell back from gemini_direct
 * to openrouter").
 */
function maybeUseFallback(
  err: unknown,
  cfg: ModelConfig,
): ProviderFallbackMeta | null {
  if (!(err instanceof ProviderHttpError)) return null;
  if (!cfg.fallback) return null;
  // Phase 8.2: use context-aware fallback policy
  if (!shouldFallbackForConfig(cfg, err.info.category)) return null;

  return {
    provider_fallback_used: true,
    provider_original_model: cfg.model,
    provider_actual_model: cfg.fallback.model,
    provider_original_provider: cfg.provider,
    provider_actual_provider: cfg.fallback.provider,
    provider_error_category: err.info.category,
    provider_error_http_status: err.info.http_status,
    provider_error_message: err.info.message,
  };
}

/**
 * callJSON — JSON extraction with one auto-repair attempt + schema key validation.
 *
 * Phase 8.1: same fallback contract as callText — if primary model fails with
 * a fallback-eligible error and `cfg.fallback` is defined, retries with the
 * fallback model and returns `provider_fallback_meta`.
 *
 * @param schema - Object with expected keys (values are unused; only keys matter for validation)
 */
export async function callJSON<T = Record<string, unknown>>(
  functionName: string,
  messages: RouterMessage[],
  schema: Record<string, unknown>,
  options: RouterCallOptions & { role?: string } = {}
): Promise<JSONResult<T>> {
  const roleLabel = options.role ? `${functionName}:${options.role}` : functionName;
  const cfg = getModelConfig(functionName, options.role);

  // Governance: callJSON allowed ONLY for strict JSON roles/functions (Gemini Pro)
  if (!CALLJSON_ALLOWED.has(roleLabel) && !CALLJSON_ALLOWED.has(functionName)) {
    throw new Error(
      `[openai-router] GOVERNANCE VIOLATION: callJSON is not allowed for "${roleLabel}". ` +
        `Only strict JSON roles may use callJSON. Use callText for legal text roles.`
    );
  }
  // Explicit block: OpenAI chat models must NEVER use callJSON
  // Phase 8.2: detect OpenAI chat either by old-style "openai/" prefix OR by
  // provider="openai_direct" with a non-embedding model name.
  const isOpenAIChatForJSON =
    (cfg.model.startsWith("openai/") && !cfg.model.startsWith("openai/text-embedding-")) ||
    (cfg.provider === "openai_direct" && !cfg.model.startsWith("text-embedding-"));
  if (isOpenAIChatForJSON) {
    throw new Error(
      `[openai-router] GOVERNANCE VIOLATION: callJSON is forbidden for OpenAI chat model "${cfg.model}" (provider=${cfg.provider}). ` +
        `Use Gemini Pro JSON roles only.`
    );
  }
  const governance = buildGovernanceMeta(cfg, roleLabel);
  const requestId = newRequestId();
  const safeMessages = prependSafetyHeader(functionName, messages);
  const timeoutMs = options.timeoutMs ?? defaultTimeout(false);

  let data: Record<string, unknown>;
  let latency_ms: number;
  let actualCfg = cfg;
  let fallbackMeta: ProviderFallbackMeta | undefined;

  try {
    const result = await fetchWithRetry(functionName, requestId, cfg, safeMessages, timeoutMs);
    data = result.data;
    latency_ms = result.latency_ms;
  } catch (err) {
    // Phase 8.1: try fallback if eligible
    const fm = maybeUseFallback(err, cfg);
    if (!fm) throw err;

    const fallbackCfg: ModelConfig = {
      ...cfg,
      provider: fm.provider_actual_provider,
      model: fm.provider_actual_model,
      temperature: cfg.fallback?.temperature ?? cfg.temperature,
      max_tokens: cfg.fallback?.max_tokens ?? cfg.max_tokens,
      json_mode: cfg.fallback?.json_mode ?? cfg.json_mode,
    };
    const result = await fetchWithRetry(functionName, requestId, fallbackCfg, safeMessages, timeoutMs);
    data = result.data;
    latency_ms = result.latency_ms;
    actualCfg = fallbackCfg;
    fallbackMeta = fm;

    console.warn(
      JSON.stringify({
        request_id: requestId,
        function_name: functionName,
        role_label: roleLabel,
        provider_fallback_used: true,
        provider_original_model: fm.provider_original_model,
        provider_actual_model: fm.provider_actual_model,
        provider_original_provider: fm.provider_original_provider,
        provider_actual_provider: fm.provider_actual_provider,
        provider_error_category: fm.provider_error_category,
        provider_error_http_status: fm.provider_error_http_status,
      })
    );
  }

  const choices = data.choices as Array<{ message: { content: string } }>;
  let raw = choices?.[0]?.message?.content ?? "";
  const usage = data.usage as JSONResult["usage"];

  // Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) raw = fenceMatch[1].trim();

  // Attempt parse — no second AI call on failure
  const parsed: T | null = tryParse<T>(raw);

  if (parsed === null) {
    console.error(
      JSON.stringify({
        request_id: requestId,
        function_name: functionName,
        error_class: "JSON_PARSE_FAIL",
        raw_length: raw.length,
      })
    );
    throw Object.assign(
      new Error(
        `[openai-router] ${functionName}: AI returned invalid JSON. No retry.`
      ),
      { code: "INVALID_JSON", raw_preview: raw.substring(0, 200) }
    );
  }

  // Schema key validation: fill missing keys with null, drop extra keys
  const validated = validateSchema<T>(parsed, schema);

  const resultGovernance = buildGovernanceMeta(actualCfg, roleLabel);

  return {
    json: validated,
    model_used: actualCfg.model,
    latency_ms,
    request_id: requestId,
    usage,
    governance: resultGovernance,
    provider_fallback_meta: fallbackMeta,
  };
}

/**
 * callTranscription — Multimodal audio/video transcription via gateway.
 * Sends audio as base64 inline content.
 *
 * Phase 8.2: now passes cfg+messages to fetchWithRetry (which routes by cfg.provider).
 */
export async function callTranscription(
  functionName: string,
  messages: RouterMessage[],
  options: RouterCallOptions = {}
): Promise<TextResult> {
  const cfg = getModelConfig(functionName);
  const governance = buildGovernanceMeta(cfg, functionName);
  const requestId = newRequestId();
  const timeoutMs = options.timeoutMs ?? defaultTimeout(true);

  const { data, latency_ms } = await fetchWithRetry(
    functionName,
    requestId,
    cfg,
    messages,
    timeoutMs
  );

  const choices = data.choices as Array<{ message: { content: string } }>;
  const text = choices?.[0]?.message?.content ?? "";
  const usage = data.usage as TextResult["usage"];

  return { text, model_used: cfg.model, latency_ms, request_id: requestId, usage, governance };
}

/**
 * callEmbeddings — Vector embeddings (delegated to embeddings-generate function).
 * Included here for API completeness; actual call is via embeddings.ts.
 */
export async function callEmbeddings(
  texts: string[]
): Promise<{ vectors: number[][]; model_used: string }> {
  // Re-use the existing embeddings-generate edge function
  const cfg = MODEL_MAP["generate-embeddings"];
  const vectors = await generateEmbeddings(texts);
  return { vectors, model_used: cfg.model };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tryParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    // Try to extract JSON object/array from surrounding text
    const objMatch = str.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]) as T;
      } catch {
        // ignore
      }
    }
    const arrMatch = str.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]) as T;
      } catch {
        // ignore
      }
    }
    return null;
  }
}

function validateSchema<T>(parsed: unknown, schema: Record<string, unknown>): T {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return parsed as T;
  }

  const obj = parsed as Record<string, unknown>;
  const schemaKeys = Object.keys(schema);

  // Fill missing keys with null
  for (const key of schemaKeys) {
    if (!(key in obj)) {
      obj[key] = null;
    }
  }

  // Drop extra keys
  for (const key of Object.keys(obj)) {
    if (!schemaKeys.includes(key)) {
      delete obj[key];
    }
  }

  return obj as T;
}

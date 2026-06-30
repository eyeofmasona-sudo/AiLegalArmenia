/**
 * _shared/ai-provider.ts — Resolves the active AI provider setting.
 *
 * Phase 8.2: three provider types are now supported:
 *   - "openai_direct"  — direct OpenAI API (api.openai.com)
 *   - "gemini_direct"  — direct Google Gemini API (generativelanguage.googleapis.com)
 *   - "openrouter"     — OpenRouter gateway (openrouter.ai)
 *
 * Each ModelConfig now specifies its preferred provider; if the direct
 * provider's API key is missing, resolveProviderForConfig() auto-downgrades
 * to OpenRouter so the request still succeeds (Phase 8.1 fallback contract
 * preserved).
 *
 * The legacy "openai" value (read from AI_PROVIDER env var or app_settings)
 * is mapped to "openai_direct" for backward compatibility.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AIProvider = "openai_direct" | "gemini_direct" | "openrouter";

/** Legacy alias kept for callers that still read AI_PROVIDER=openai. */
export type LegacyAIProvider = "openai" | "openrouter";

let cachedProvider: AIProvider | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds
const DEFAULT_AI_PROVIDER: AIProvider = "openrouter";

/**
 * Functions that MUST always use direct OpenAI (embeddings, enrich workers).
 * These bypass the provider setting entirely.
 */
const OPENAI_ONLY_FUNCTIONS = new Set([
  "generate-embeddings",
  "practice-embed-worker",
  "practice-ai-enrich-worker",
  "legal-practice-enrich",
  "vector-search-rerank",
]);

/**
 * Check if a function must bypass provider routing and use OpenAI directly.
 */
export function isOpenAIOnlyFunction(functionName: string): boolean {
  return OPENAI_ONLY_FUNCTIONS.has(functionName);
}

/**
 * Get the configured AI provider. Caches for 30s.
 *
 * Phase 8.2: legacy "openai" value is mapped to "openai_direct".
 * Per-ModelConfig provider preferences (set in MODEL_MAP) take precedence
 * over this global setting — see resolveProviderForConfig().
 */
export async function getAIProvider(): Promise<AIProvider> {
  const now = Date.now();
  if (cachedProvider && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedProvider;
  }

  const envProvider = Deno.env.get("AI_PROVIDER")?.toLowerCase();
  if (envProvider === "openai" || envProvider === "openai_direct") {
    cachedProvider = "openai_direct";
    cacheTimestamp = now;
    return cachedProvider;
  }
  if (envProvider === "openrouter") {
    cachedProvider = "openrouter";
    cacheTimestamp = now;
    return cachedProvider;
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
      console.warn(`[ai-provider] Missing SUPABASE_URL or SERVICE_ROLE_KEY, defaulting to ${DEFAULT_AI_PROVIDER}`);
      cachedProvider = DEFAULT_AI_PROVIDER;
      cacheTimestamp = now;
      return cachedProvider;
    }

    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ai_provider")
      .single();

    if (error || !data) {
      console.warn(`[ai-provider] Could not read ai_provider setting, defaulting to ${DEFAULT_AI_PROVIDER}:`, error?.message);
      cachedProvider = DEFAULT_AI_PROVIDER;
    } else {
      const val = data.value as string;
      if (val === "openai" || val === "openai_direct") {
        cachedProvider = "openai_direct";
      } else if (val === "openrouter") {
        cachedProvider = "openrouter";
      } else {
        cachedProvider = DEFAULT_AI_PROVIDER;
      }
    }
  } catch (e) {
    console.warn("[ai-provider] Error reading setting:", e);
    cachedProvider = DEFAULT_AI_PROVIDER;
  }

  cacheTimestamp = now;
  return cachedProvider!;
}

/**
 * Phase 8.2 — Resolve the actual provider to use for a ModelConfig.
 *
 * Rules:
 *   1. If cfg.provider is "openai_direct" but OPENAI_API_KEY is missing → "openrouter"
 *   2. If cfg.provider is "gemini_direct" but GEMINI_API_KEY is missing → "openrouter"
 *   3. Otherwise → cfg.provider (or "openrouter" if undefined)
 *
 * This ensures requests never fail because of a missing direct-provider key —
 * they transparently fall through to OpenRouter (which has its own key).
 */
export function resolveProviderForConfig(
  cfg: { provider?: AIProvider; model: string },
): AIProvider {
  const provider = cfg.provider ?? "openrouter";

  if (provider === "openai_direct" && !Deno.env.get("OPENAI_API_KEY")) {
    return "openrouter";
  }
  if (provider === "gemini_direct" && !Deno.env.get("GEMINI_API_KEY")) {
    return "openrouter";
  }

  return provider;
}

/**
 * Phase 8.2 — Convert a canonical model name (without vendor prefix) to the
 * format expected by the given provider.
 *
 *   openai_direct: "gpt-4.1-mini"           → "gpt-4.1-mini"        (no change)
 *   gemini_direct: "gemini-2.5-pro"          → "gemini-2.5-pro"      (no change)
 *   openrouter:    "gpt-4.1-mini"            → "openai/gpt-4.1-mini"
 *                  "gemini-2.5-pro"           → "google/gemini-2.5-pro"
 *                  "deepseek/deepseek-chat"   → "deepseek/deepseek-chat" (already prefixed)
 *                  "anthropic/claude-3.5-sonnet" → unchanged (already prefixed)
 */
export function modelForProvider(canonicalModel: string, provider: AIProvider): string {
  if (provider === "openrouter") {
    // Already has a vendor prefix → leave as-is
    if (canonicalModel.includes("/")) return canonicalModel;
    // Add vendor prefix based on model family
    if (canonicalModel.startsWith("gpt-") || canonicalModel.startsWith("text-embedding-")) {
      return `openai/${canonicalModel}`;
    }
    if (canonicalModel.startsWith("gemini-")) {
      return `google/${canonicalModel}`;
    }
    if (canonicalModel.startsWith("claude-")) {
      return `anthropic/${canonicalModel}`;
    }
    // Unknown family — return as-is and let OpenRouter reject if invalid
    return canonicalModel;
  }
  // Direct providers — strip any vendor prefix
  return canonicalModel.replace(/^(openai|google|anthropic)\//, "");
}

/**
 * Phase 8.2 — Get the endpoint URL and API key for a specific provider + model.
 *
 * Routing rules:
 *   - OpenAI embedding models → always direct OpenAI API (regardless of provider)
 *   - "openai_direct" provider → api.openai.com/v1/chat/completions
 *   - "gemini_direct" provider → generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 *   - "openrouter" provider    → openrouter.ai/api/v1/chat/completions
 *
 * Returns:
 *   - url          — the endpoint URL to POST to
 *   - apiKey       — the API key to use in Authorization / x-goog-api-key header
 *   - modelForApi  — the model name in the provider's expected format
 *   - authHeader   — the header name to use for auth ("Authorization" or "x-goog-api-key")
 *   - provider     — the resolved provider (for caller to switch on for adapter logic)
 */
export function resolveEndpoint(
  provider: AIProvider,
  modelName: string,
  functionName?: string,
): {
  url: string;
  apiKey: string;
  modelForApi: string;
  authHeader: "Authorization" | "x-goog-api-key";
  provider: AIProvider;
} {
  // Embedding models always go direct to OpenAI (regardless of cfg.provider)
  if (modelName.startsWith("openai/text-embedding-")) {
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("[ai-provider] OPENAI_API_KEY is not configured for embeddings");
    const rawModel = modelName.replace(/^openai\//, "");
    return {
      url: "https://api.openai.com/v1/embeddings",
      apiKey: key,
      modelForApi: rawModel,
      authHeader: "Authorization",
      provider: "openai_direct",
    };
  }

  // Functions that must always use direct OpenAI (bypass provider routing)
  if (functionName && isOpenAIOnlyFunction(functionName)) {
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("[ai-provider] OPENAI_API_KEY is not configured for OpenAI-only function");
    const rawModel = modelName.replace(/^openai\//, "");
    return {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: key,
      modelForApi: rawModel,
      authHeader: "Authorization",
      provider: "openai_direct",
    };
  }

  // Direct OpenAI provider
  if (provider === "openai_direct") {
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("[ai-provider] OPENAI_API_KEY is not configured for openai_direct provider");
    const rawModel = modelName.replace(/^(openai|google|anthropic)\//, "");
    return {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: key,
      modelForApi: rawModel,
      authHeader: "Authorization",
      provider,
    };
  }

  // Direct Gemini provider
  if (provider === "gemini_direct") {
    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) throw new Error("[ai-provider] GEMINI_API_KEY is not configured for gemini_direct provider");
    const rawModel = modelName.replace(/^(openai|google|anthropic)\//, "");
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${rawModel}:generateContent`,
      apiKey: key,
      modelForApi: rawModel,
      authHeader: "x-goog-api-key",
      provider,
    };
  }

  // OpenRouter provider (default / fallback)
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("[ai-provider] OPENROUTER_API_KEY is not configured for OpenRouter mode");
  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: key,
    modelForApi: modelName, // OpenRouter accepts full vendor-prefixed names
    authHeader: "Authorization",
    provider,
  };
}

/**
 * Phase 8.2 — Resolve the streaming endpoint URL for the given provider + model.
 * Same as resolveEndpoint but uses the streaming endpoint variants.
 *
 *   - openai_direct: api.openai.com/v1/chat/completions (with stream:true in body)
 *   - gemini_direct: generativelanguage.googleapis.com/v1beta/models/<model>:streamGenerateContent?alt=sse
 *   - openrouter:    openrouter.ai/api/v1/chat/completions (with stream:true in body)
 */
export function resolveStreamEndpoint(
  provider: AIProvider,
  modelName: string,
  functionName?: string,
): {
  url: string;
  apiKey: string;
  modelForApi: string;
  authHeader: "Authorization" | "x-goog-api-key";
  provider: AIProvider;
} {
  // Embeddings and OpenAI-only functions are never streamed
  if (modelName.startsWith("openai/text-embedding-")) {
    throw new Error("[ai-provider] Embedding models do not support streaming");
  }
  if (functionName && isOpenAIOnlyFunction(functionName)) {
    throw new Error(`[ai-provider] ${functionName} is OpenAI-only and not streamable`);
  }

  if (provider === "gemini_direct") {
    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) throw new Error("[ai-provider] GEMINI_API_KEY is not configured for gemini_direct provider");
    const rawModel = modelName.replace(/^(openai|google|anthropic)\//, "");
    // Gemini streaming uses streamGenerateContent with alt=sse for SSE format
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${rawModel}:streamGenerateContent?alt=sse`,
      apiKey: key,
      modelForApi: rawModel,
      authHeader: "x-goog-api-key",
      provider,
    };
  }

  // openai_direct and openrouter use the same chat completions endpoint with stream:true
  return resolveEndpoint(provider, modelName, functionName);
}

/**
 * _shared/ai-provider.ts — Resolves the active AI provider setting.
 *
 * Reads `ai_provider` from `app_settings` table.
 * Values: "openai" (direct OpenAI API) | "openrouter" (OpenRouter API).
 * Default: "openrouter", because the current model registry uses Anthropic/Gemini IDs.
 *
 * Cached per cold-start to avoid repeated DB calls within the same invocation.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AIProvider = "openai" | "openrouter";

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
 */
export async function getAIProvider(): Promise<AIProvider> {
  const now = Date.now();
  if (cachedProvider && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedProvider;
  }

  const envProvider = Deno.env.get("AI_PROVIDER")?.toLowerCase();
  if (envProvider === "openai" || envProvider === "openrouter") {
    cachedProvider = envProvider;
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
      if (val === "openai") {
        cachedProvider = "openai";
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
 * Get the endpoint URL and API key for the active provider.
 *
 * Routing rules:
 *   - OpenAI embedding models → always direct OpenAI API
 *   - "openrouter" provider → OpenRouter API
 *   - "openai" provider → direct OpenAI API (strips "openai/" prefix)
 */
export function resolveEndpoint(
  provider: AIProvider,
  modelName: string,
  functionName?: string
): { url: string; apiKey: string; modelForApi: string } {
  // Embedding models always go direct to OpenAI
  if (modelName.startsWith("openai/text-embedding-")) {
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("[ai-provider] OPENAI_API_KEY is not configured for embeddings");
    const rawModel = modelName.replace(/^openai\//, "");
    return {
      url: "https://api.openai.com/v1/embeddings",
      apiKey: key,
      modelForApi: rawModel,
    };
  }

  // Functions that must always use direct OpenAI
  if (functionName && isOpenAIOnlyFunction(functionName)) {
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("[ai-provider] OPENAI_API_KEY is not configured for OpenAI-only function");
    const rawModel = modelName.replace(/^openai\//, "");
    return {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: key,
      modelForApi: rawModel,
    };
  }

  // OpenRouter provider: route ALL models (including google/*) through OpenRouter
  if (provider === "openrouter") {
    const key = Deno.env.get("OPENROUTER_API_KEY");
    if (!key) throw new Error("[ai-provider] OPENROUTER_API_KEY is not configured for OpenRouter mode");
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: key,
      modelForApi: modelName, // OpenRouter accepts full model names like "google/gemini-2.5-flash:free"
    };
  }

  // Direct OpenAI provider
  if (provider === "openai" && modelName.startsWith("openai/")) {
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("[ai-provider] OPENAI_API_KEY is not configured for direct OpenAI mode");
    const rawModel = modelName.replace(/^openai\//, "");
    return {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: key,
      modelForApi: rawModel,
    };
  }

  throw new Error(
    `[ai-provider] ${functionName ?? "unknown function"} model "${modelName}" is not compatible with AI_PROVIDER=openai. ` +
      `Set AI_PROVIDER=openrouter or configure this function with an openai/* model.`
  );
}

/**
 * _shared/gateway-bypass.ts — Centralized helper for edge functions
 * that MUST call an AI provider directly (e.g. tool_calling, streaming, multimodal).
 *
 * All bypass calls MUST resolve model/temperature/max_tokens from MODEL_MAP
 * to prevent model drift. Every call is logged with bypass_reason.
 *
 * Phase 8.1: callStreamBypass now supports automatic fallback to
 * `cfg.fallback.model` when the primary model returns 403 (region_blocked),
 * 404 (unavailable), or 5xx (server_error). The caller is informed via the
 * returned `provider_fallback_meta` field so it can be surfaced to the user
 * (e.g. as part of the SSE pipeline_metadata event).
 *
 * Phase 8.2: now respects cfg.provider (openai_direct / gemini_direct / openrouter).
 *   - gemini_direct streaming uses the streamGenerateContent endpoint with alt=sse
 *     and a TransformStream that converts Gemini SSE chunks → OpenAI SSE chunks
 *     on the fly, so the caller (legal-chat) can keep parsing OpenAI-format deltas.
 *   - gemini_direct non-streaming uses generateContent + fromGeminiResponse adapter.
 *   - openai_direct / openrouter keep the existing OpenAI-format flow.
 *   - If a direct provider's API key is missing, resolveProviderForConfig()
 *     auto-downgrades to openrouter transparently.
 */

import {
  getModelConfig,
  toGeminiRequest,
  fromGeminiResponse,
  shouldFallback,
  shouldFallbackForDirectProvider,
  type ModelConfig,
  type ProviderFallbackMeta,
  type ProviderErrorCategory,
  type ProviderErrorInfo,
} from "./openai-router.ts";
import {
  resolveEndpoint,
  resolveStreamEndpoint,
  resolveProviderForConfig,
  modelForProvider,
  type AIProvider,
} from "./ai-provider.ts";

export interface BypassOptions {
  /** Function name for MODEL_MAP lookup */
  functionName: string;
  /** Reason for bypassing the router (e.g. "tool_calling", "streaming", "multimodal") */
  bypassReason: string;
  /** Additional body fields (tools, tool_choice, stream, etc.) — OpenAI-format only */
  extraBody?: Record<string, unknown>;
  /** Override timeout in ms (default 60000) */
  timeoutMs?: number;
  /** Max retries on 5xx/429 (default 0) */
  maxRetries?: number;
}

export interface BypassResult {
  data: Record<string, unknown>;
  model_used: string;
  latency_ms: number;
  request_id: string;
  /** Present ONLY when a provider fallback was used (Phase 8.1). */
  provider_fallback_meta?: ProviderFallbackMeta;
}

/**
 * Phase 8.1 — Mirror of openai-router's shouldFallback + classifyProviderError,
 * but works on a raw Response object (since gateway-bypass uses streaming /
 * tool-calling paths that don't go through fetchWithRetry).
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
 * Phase 8.2 — Context-aware fallback policy (mirrors openai-router's shouldFallbackForConfig).
 * When primary is openai_direct / gemini_direct and fallback is openrouter
 * (different account), quota (402) and rate_limit (429) also trigger fallback.
 */
function shouldFallbackForConfigLocal(
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

/**
 * Build a provider-specific request body for bypass calls.
 *
 * Phase 8.2:
 *   - gemini_direct: convert to Gemini format via toGeminiRequest (extraBody is
 *     ignored — Gemini doesn't support OpenAI-style tool/stream parameters
 *     directly; callers that need streaming must use callStreamBypass).
 *   - openai_direct / openrouter: keep OpenAI format with model + messages + temp + max_tokens
 *     (plus any extra fields like tools, tool_choice, stream).
 */
function buildBypassBody(
  cfg: ModelConfig,
  messages: Array<{ role: string; content: unknown }>,
  provider: AIProvider,
  extraBody?: Record<string, unknown>,
): Record<string, unknown> {
  if (provider === "gemini_direct") {
    // toGeminiRequest expects RouterMessage[] (same shape as our messages array)
    return toGeminiRequest(messages as Array<{ role: "system" | "user" | "assistant"; content: string | unknown[] }>, cfg);
  }
  // openai_direct or openrouter — OpenAI format
  const base: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
  };
  if (extraBody) {
    Object.assign(base, extraBody);
  }
  return base;
}

/**
 * Phase 8.2 — Build the auth headers for a given provider.
 *   - gemini_direct: x-goog-api-key header (no Bearer prefix)
 *   - openai_direct / openrouter: Authorization: Bearer
 */
function buildAuthHeaders(endpoint: { authHeader: "Authorization" | "x-goog-api-key"; apiKey: string }): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.authHeader === "x-goog-api-key") {
    headers["x-goog-api-key"] = endpoint.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
  }
  return headers;
}

/**
 * Phase 8.2 — Create a TransformStream that converts Gemini SSE chunks
 * (data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}) into
 * OpenAI SSE chunks (data: {"choices":[{"delta":{"content":"..."}}]}).
 *
 * This allows legal-chat's existing SSE parser to consume Gemini streams
 * without modification.
 *
 * Final Gemini event includes usageMetadata — we emit a final OpenAI chunk
 * with finish_reason: "stop" and a usage field.
 */
function createGeminiToOpenAiSseTransformer(): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Split on double-newline (SSE event boundary) OR single newline (data: line)
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith("data: ")) continue;
        const jsonStr = trimmed.slice(6).trim();
        if (jsonStr === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          continue;
        }
        try {
          const parsed = JSON.parse(jsonStr);
          // Extract text from Gemini chunk
          const candidates = parsed.candidates as Array<{
            content?: { parts?: Array<{ text?: string }>; role?: string };
            finishReason?: string;
          }> | undefined;
          const text = candidates?.[0]?.content?.parts
            ?.map((p) => p.text ?? "")
            .join("") ?? "";
          const finishReason = candidates?.[0]?.finishReason;
          const usageMetadata = parsed.usageMetadata as {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            totalTokenCount?: number;
          } | undefined;

          // Emit as OpenAI delta chunk
          const openAiChunk: Record<string, unknown> = {
            choices: [{
              index: 0,
              delta: text ? { content: text } : {},
              finish_reason: finishReason ? "stop" : null,
            }],
          };
          if (usageMetadata) {
            openAiChunk.usage = {
              prompt_tokens: usageMetadata.promptTokenCount ?? 0,
              completion_tokens: usageMetadata.candidatesTokenCount ?? 0,
              total_tokens: usageMetadata.totalTokenCount ?? 0,
            };
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`));
        } catch {
          // Not JSON — skip (could be a Gemini keep-alive comment like ": OPENROUTER PROCESSING")
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        // Process any residual line
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ")) {
          try {
            const jsonStr = trimmed.slice(6).trim();
            const parsed = JSON.parse(jsonStr);
            const candidates = parsed.candidates as Array<{
              content?: { parts?: Array<{ text?: string }> };
              finishReason?: string;
            }> | undefined;
            const text = candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
            const openAiChunk = {
              choices: [{
                index: 0,
                delta: text ? { content: text } : {},
                finish_reason: "stop",
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`));
          } catch {
            // ignore
          }
        }
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });

  return { readable, writable };
}

/**
 * Execute a provider bypass call with mandatory logging and optional retries.
 *
 * Phase 8.2: now uses cfg.provider to route to the correct endpoint. For
 * gemini_direct, the response is converted from Gemini format to OpenAI format
 * via fromGeminiResponse() before returning.
 */
export async function callGatewayBypass(
  messages: Array<{ role: string; content: unknown }>,
  options: BypassOptions
): Promise<BypassResult> {
  const cfg = getModelConfig(options.functionName);
  const requestId = crypto.randomUUID();

  // Phase 8.2: resolve provider from cfg (auto-downgrade if direct key missing)
  const resolvedProvider = resolveProviderForConfig(cfg);
  const endpoint = resolveEndpoint(resolvedProvider, cfg.model, options.functionName);

  // Build provider-specific request body
  const body = buildBypassBody(cfg, messages, resolvedProvider, options.extraBody);
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxRetries = options.maxRetries ?? 0;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: buildAuthHeaders(endpoint),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latency_ms = Date.now() - t0;

      // Mandatory bypass log
      console.log(JSON.stringify({
        fn: options.functionName,
        provider: resolvedProvider,
        model: cfg.model,
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        request_id: requestId,
        latency_ms,
        status: response.status,
        attempt,
        bypass_reason: options.bypassReason,
      }));

      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          await new Promise(r => setTimeout(r, backoff));
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }

        const errText = await response.text().catch(() => "");
        throw Object.assign(
          new Error(`AI provider error ${response.status}: ${errText.substring(0, 200)}`),
          { status: response.status }
        );
      }

      const rawData = await response.json() as Record<string, unknown>;
      // Phase 8.2: convert Gemini response to OpenAI format
      const data = resolvedProvider === "gemini_direct"
        ? fromGeminiResponse(rawData)
        : rawData;

      return {
        data,
        model_used: cfg.model,
        latency_ms,
        request_id: requestId,
      };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries && !(err instanceof Error && (err as Error & { status?: number }).status === 402)) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("[gateway-bypass] Max retries exceeded");
}

/**
 * Execute a streaming provider bypass call. Returns the raw Response
 * so the caller can pipe response.body to the client.
 *
 * Phase 8.1: if the primary model returns 403 (region_blocked), 404 (unavailable),
 * or 5xx (server_error) AND `cfg.fallback` is defined, automatically retries with
 * the fallback model.
 *
 * Phase 8.2: respects cfg.provider. For gemini_direct streaming:
 *   - Uses streamGenerateContent endpoint with alt=sse
 *   - Wraps the response body in a TransformStream that converts Gemini SSE → OpenAI SSE
 *     so the caller can parse the stream as if it came from OpenAI
 *   - The returned Response's body is the transformed stream (not the raw Gemini stream)
 *
 * 402 (quota) and 429 (rate_limit) errors do NOT trigger fallback.
 */
export async function callStreamBypass(
  messages: Array<{ role: string; content: unknown }>,
  options: BypassOptions
): Promise<{
  response: Response;
  model_used: string;
  request_id: string;
  provider_fallback_meta?: ProviderFallbackMeta;
}> {
  const cfg = getModelConfig(options.functionName);
  const requestId = crypto.randomUUID();

  async function doFetch(
    provider: AIProvider,
    cfgForFetch: ModelConfig,
  ): Promise<Response> {
    const t0 = Date.now();
    const endpoint = resolveStreamEndpoint(provider, cfgForFetch.model, options.functionName);
    // Build provider-specific body. For streaming, openai/openrouter need stream:true.
    // Gemini streaming is controlled by the endpoint URL (streamGenerateContent), not body.
    const body = buildBypassBody(cfgForFetch, messages, provider, options.extraBody);
    if (provider !== "gemini_direct") {
      // openai_direct / openrouter — add stream:true
      (body as Record<string, unknown>).stream = true;
    }
    // For openrouter, model name needs vendor prefix
    if (provider === "openrouter") {
      (body as Record<string, unknown>).model = modelForProvider(cfgForFetch.model, "openrouter");
    } else {
      (body as Record<string, unknown>).model = endpoint.modelForApi;
    }

    const timeoutMs = options.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(endpoint.url, {
        method: "POST",
        headers: buildAuthHeaders(endpoint),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latency_ms = Date.now() - t0;
      console.log(JSON.stringify({
        fn: options.functionName,
        provider,
        model: cfgForFetch.model,
        temperature: cfgForFetch.temperature,
        max_tokens: cfgForFetch.max_tokens,
        request_id: requestId,
        latency_ms,
        status: r.status,
        bypass_reason: options.bypassReason,
      }));
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  // Phase 8.2: resolve provider (auto-downgrade if direct key missing)
  const primaryProvider = resolveProviderForConfig(cfg);
  let response = await doFetch(primaryProvider, cfg);

  // Phase 8.1: if primary failed with a fallback-eligible error, try fallback.
  // Phase 8.2: use context-aware policy (direct→openrouter allows fallback on 402/429 too).
  if (!response.ok && cfg.fallback) {
    const info = await classifyProviderError(response);
    if (shouldFallbackForConfigLocal(cfg, info.category)) {
      // Build fallback cfg
      const fallbackCfg: ModelConfig = {
        ...cfg,
        provider: cfg.fallback.provider,
        model: cfg.fallback.model,
        temperature: cfg.fallback.temperature ?? cfg.temperature,
        max_tokens: cfg.fallback.max_tokens ?? cfg.max_tokens,
        json_mode: cfg.fallback.json_mode ?? cfg.json_mode,
        // Don't recurse into fallback's fallback
        fallback: undefined,
      };
      const fallbackProvider = resolveProviderForConfig(fallbackCfg);
      const fallbackResponse = await doFetch(fallbackProvider, fallbackCfg);

      const fallbackMeta: ProviderFallbackMeta = {
        provider_fallback_used: true,
        provider_original_model: cfg.model,
        provider_actual_model: cfg.fallback.model,
        provider_original_provider: cfg.provider,
        provider_actual_provider: cfg.fallback.provider,
        provider_error_category: info.category,
        provider_error_http_status: info.http_status,
        provider_error_message: info.message,
      };

      if (fallbackResponse.ok) {
        console.warn(JSON.stringify({
          request_id: requestId,
          fn: options.functionName,
          provider_fallback_used: true,
          provider_original_model: fallbackMeta.provider_original_model,
          provider_actual_model: fallbackMeta.provider_actual_model,
          provider_original_provider: fallbackMeta.provider_original_provider,
          provider_actual_provider: fallbackMeta.provider_actual_provider,
          provider_error_category: fallbackMeta.provider_error_category,
          provider_error_http_status: fallbackMeta.provider_error_http_status,
        }));

        // Phase 8.2: if fallback is gemini_direct streaming, wrap response body with transformer
        if (fallbackProvider === "gemini_direct") {
          const transformer = createGeminiToOpenAiSseTransformer();
          // Pipe the fallback response body through the transformer
          fallbackResponse.body?.pipeTo(transformer.writable).catch(() => {});
          const transformedResponse = new Response(transformer.readable, {
            status: fallbackResponse.status,
            statusText: fallbackResponse.statusText,
            headers: fallbackResponse.headers,
          });
          return {
            response: transformedResponse,
            model_used: fallbackCfg.model,
            request_id: requestId,
            provider_fallback_meta: fallbackMeta,
          };
        }

        return {
          response: fallbackResponse,
          model_used: fallbackCfg.model,
          request_id: requestId,
          provider_fallback_meta: fallbackMeta,
        };
      }
      // Fallback also failed — return its response + meta
      return {
        response: fallbackResponse,
        model_used: fallbackCfg.model,
        request_id: requestId,
        provider_fallback_meta: fallbackMeta,
      };
    }
  }

  // Phase 8.2: if primary succeeded AND provider is gemini_direct streaming,
  // wrap the response body with the Gemini→OpenAI SSE transformer.
  if (response.ok && primaryProvider === "gemini_direct") {
    const transformer = createGeminiToOpenAiSseTransformer();
    response.body?.pipeTo(transformer.writable).catch(() => {});
    const transformedResponse = new Response(transformer.readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    return { response: transformedResponse, model_used: cfg.model, request_id: requestId };
  }

  return { response, model_used: cfg.model, request_id: requestId };
}

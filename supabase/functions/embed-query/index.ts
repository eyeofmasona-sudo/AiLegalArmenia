import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";
import { handleCors } from "../_shared/edge-security.ts";

// AI LEGAL ARMENIA — query embedding proxy.
//
// Why: vector search needs a query vector with the SAME model/semantics as the
// indexed passages (Metric-AI/armenian-text-embeddings-2-large, 1024-dim,
// "query:" prefix). That model runs in a self-hosted FastAPI service
// (scripts/embedding_server.py), NOT in Deno. This edge function is a thin,
// authenticated server-side proxy to that service so the endpoint URL and the
// optional API key stay OFF the client.
//
// ENV (set in Supabase → Edge Functions → Secrets):
//   EMBEDDING_ENDPOINT   e.g. https://embeddings.example.com   (must be reachable from edge)
//   EMBEDDING_API_KEY    optional shared secret -> sent as X-API-Key
//
// Request : { text: string }
// Response: { vector: number[], dimension: number, model: string }
// On any failure the caller (LegalSearch) falls back to FTS — so a missing or
// unreachable endpoint degrades gracefully, never breaks search.

interface EmbedBody {
  text?: string;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors.errorResponse) return cors.errorResponse;
  const headers = { ...cors.corsHeaders, "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) throw new Error("Supabase env not configured");

    // Auth guard: only authenticated users may embed (prevents open abuse).
    const authHeader = req.headers.get("Authorization") ?? "";
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const endpoint = Deno.env.get("EMBEDDING_ENDPOINT");
    if (!endpoint) {
      // Not configured -> signal caller to use FTS fallback.
      return new Response(JSON.stringify({ error: "embedding_endpoint_unset" }), { status: 503, headers });
    }
    // Edge cannot reach localhost/private IPs on the VPS. A non-routable endpoint here
    // means semantic search is silently degraded — surface it instead of timing out.
    if (/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?|:\/\/10\.|:\/\/192\.168\.|:\/\/172\.(1[6-9]|2\d|3[01])\.)/i.test(endpoint)) {
      console.warn("[embed-query] EMBEDDING_ENDPOINT is not routable from Supabase Edge (localhost/private IP); set a public HTTPS URL in Edge Secrets");
      return new Response(JSON.stringify({ error: "embedding_endpoint_unroutable" }), { status: 503, headers });
    }

    const body = (await req.json()) as EmbedBody;
    const text = (body.text ?? "").trim();
    if (!text) {
      return new Response(JSON.stringify({ error: "text is required" }), { status: 400, headers });
    }

    const apiKey = Deno.env.get("EMBEDDING_API_KEY");
    const upstreamHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) upstreamHeaders["X-API-Key"] = apiKey;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let upstream: Response;
    try {
      upstream = await fetch(`${endpoint.replace(/\/+$/, "")}/embed/query`, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify({ texts: text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `embedding_service_${upstream.status}` }),
        { status: 502, headers },
      );
    }

    const payload = await upstream.json() as {
      model?: string;
      dimension?: number;
      vectors?: number[][];
    };
    const vector = payload.vectors?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      return new Response(JSON.stringify({ error: "empty_embedding" }), { status: 502, headers });
    }

    return new Response(
      JSON.stringify({ vector, dimension: payload.dimension ?? vector.length, model: payload.model ?? null }),
      { status: 200, headers },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "embed-query failed" }),
      { status: 500, headers },
    );
  }
});

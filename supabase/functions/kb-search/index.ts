import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";
import { log, warn, err } from "../_shared/safe-logger.ts";

import { handleCors } from "../_shared/edge-security.ts";

// в”Ђв”Ђв”Ђ Types в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

interface SearchRequest {
  query: string;
  category?: "criminal" | "civil" | "administrative" | "echr" | "constitutional" | null;
  limitDocs?: number;
  limitChunksPerDoc?: number;
}

interface TopChunk {
  chunkIndex: number;
  text: string;
}

interface SearchResultDocument {
  id: string;
  title: string;
  practice_category: string;
  court_type: string;
  outcome: string;
  applied_articles: unknown[];
  key_violations: string[];
  legal_reasoning_summary: string | null;
  decision_map: unknown | null;
  key_paragraphs: unknown[];
  top_chunks: TopChunk[];
  totalChunks: number;
  max_score?: number;
}

interface ChunksRpcDoc {
  id: string;
  title: string;
  practice_category: string;
  court_type: string;
  outcome: string;
  decision_date: string | null;
  source_url: string | null;
  max_score: number;
}

interface ChunksRpcChunk {
  doc_id: string;
  chunk_index: number;
  excerpt: string;
  score: number;
}

interface ChunksRpcResponse {
  documents: ChunksRpcDoc[];
  chunks: ChunksRpcChunk[];
}

interface CorpusRow {
  chunk_id: string;
  document_id: string;
  doc_id: string | null;
  title: string | null;
  text_snippet: string | null;
  source_url: string | null;
  source: string | null;
  score: number;
}

type CorpusRpcClient = {
  rpc: (
    fn: "search_legal_corpus_dual",
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

// в”Ђв”Ђв”Ђ Constants в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

const ALLOWED_CATEGORIES = new Set([
  "criminal", "civil", "administrative", "echr", "constitutional",
]);

const defaultCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Decode the minimal safe set of HTML entities that may appear in user input */
const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&#39;": "'",
  "&apos;": "'",
};
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#34|#39);/gi;

// в”Ђв”Ђв”Ђ Handler в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

serve(async (req) => {
  const cors = handleCors(req);
  if (cors.errorResponse) return cors.errorResponse;
  const corsHeaders = cors.corsHeaders!;

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const requestId = crypto.randomUUID().slice(0, 8);

  try {
    // === AUTH GUARD (getUser via Authorization header) ===
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonRes({ error: "Unauthorized" }, 401);
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: authError } = await sb.auth.getUser();
    if (authError || !userData?.user?.id) {
      return jsonRes({ error: "Unauthorized" }, 401);
    }

    // === Rate limiting ===
    const supabaseServiceUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseServiceUrl, supabaseServiceRoleKey);
    const { checkRateLimits } = await import("../_shared/rate-limiter.ts");
    const rateCheck = await checkRateLimits(serviceClient, userData.user.id, "kb-search");
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: rateCheck.reason, message: rateCheck.message }),
        { status: rateCheck.status || 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // === End rate limiting ===

    // === Method check ===
    if (req.method !== "POST") {
      return jsonRes({ error: "Method not allowed" }, 405);
    }

    // === Parse & validate ===
    const body: SearchRequest = await req.json();
    const { category = null, limitDocs = 20, limitChunksPerDoc = 4 } = body;
    const rawQuery = body.query;

    if (!rawQuery || typeof rawQuery !== "string") {
      return jsonRes({ error: "Query is required" }, 400);
    }

    const query = normalizeSearchQuery(rawQuery);
    if (query.length < 2) {
      return jsonRes({ error: "Query too short" }, 400);
    }

    if (category != null && !ALLOWED_CATEGORIES.has(category)) {
      return jsonRes({ error: "Invalid category" }, 400);
    }

    const safeLimitDocs = Math.max(1, Math.min(Number(limitDocs) || 20, 20));
    const safeChunksPerDoc = Math.max(1, Math.min(Number(limitChunksPerDoc) || 4, 6));

    log("kb-search", "Search start", { requestId, qLen: query.length, category });
    const rpcClient = sb as unknown as CorpusRpcClient;

    // === PRIMARY: unified corpus search ===
    let path = "chunks";
    let results: SearchResultDocument[];

    try {
      results = await searchViaChunksRpc(rpcClient, query, category, safeLimitDocs, safeChunksPerDoc);
    } catch (e) {
      warn("kb-search", "Chunks RPC failed, falling back", { requestId });
      results = [];
    }

    // === FALLBACK: repeat unified corpus search with document limit ===
    if (results.length === 0) {
      path = "fallback";
      try {
        results = await searchViaFallbackRpc(rpcClient, query, category, safeLimitDocs);
      } catch (e) {
        err("kb-search", "Fallback RPC also failed", e, { requestId });
        results = [];
      }
    }

    log("kb-search", "Search done", { requestId, path, docs: results.length });

    return new Response(
      JSON.stringify({
        documents: results,
        retrieval_mode: "keyword_only",
        semantic_ok: false,
        semantic_error: "SEMANTIC_EMBEDDING_NOT_REQUESTED",
        qwen_semantic_ok: false,
        qwen_semantic_error: "QWEN_QUERY_EMBEDDING_UNAVAILABLE",
        threshold_applied: false,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    err("kb-search", "Unhandled error", error, { requestId });
    return jsonRes({ error: "Search failed" }, 500);
  }
});

// в”Ђв”Ђв”Ђ PRIMARY: Chunks RPC в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

async function searchViaChunksRpc(
  sb: CorpusRpcClient,
  query: string,
  category: string | null,
  limitDocs: number,
  chunksPerDoc: number,
): Promise<SearchResultDocument[]> {
  const { data, error } = await sb.rpc("search_legal_corpus_dual", {
    p_query_text: query,
    p_metric_embedding: null,
    p_qwen_embedding: null,
    p_content_domain: "practice",
    p_norm_status: "active",
    p_limit: Math.max(limitDocs * chunksPerDoc, limitDocs),
    p_metric_limit: 0,
    p_qwen_limit: 0,
    p_bm25_limit: Math.max(limitDocs * chunksPerDoc, 30),
    p_effective_at: null,
  });

  if (error) throw new Error(`search_legal_corpus_dual RPC: ${error.message}`);
  if (!data) return [];

  const rows = (Array.isArray(data) ? data : []) as CorpusRow[];
  const docMap = new Map<string, ChunksRpcDoc>();
  const chunks: ChunksRpcChunk[] = [];

  for (const row of rows) {
    if (!docMap.has(row.document_id)) {
      docMap.set(row.document_id, {
        id: row.document_id,
        title: row.title || row.doc_id || "Untitled",
        practice_category: row.source === "echr" ? "echr" : (category || ""),
        court_type: row.source || "",
        outcome: "",
        decision_date: null,
        source_url: row.source_url,
        max_score: Number(row.score) || 0,
      });
    }
    chunks.push({
      doc_id: row.document_id,
      chunk_index: chunks.filter((chunk) => chunk.doc_id === row.document_id).length,
      excerpt: row.text_snippet || "",
      score: Number(row.score) || 0,
    });
  }

  const docs = [...docMap.values()].slice(0, limitDocs);

  if (docs.length === 0) return [];

  // Group chunks by doc_id
  const chunksByDoc = new Map<string, ChunksRpcChunk[]>();
  for (const c of chunks) {
    const arr = chunksByDoc.get(c.doc_id) || [];
    arr.push(c);
    chunksByDoc.set(c.doc_id, arr);
  }

  return docs.map((doc) => {
    const docChunks = chunksByDoc.get(doc.id) || [];
    // Use first chunk excerpt as legal_reasoning_summary preview
    const preview = docChunks.length > 0
      ? docChunks[0].excerpt.substring(0, 500)
      : null;

    return {
      id: doc.id,
      title: doc.title,
      practice_category: doc.practice_category,
      court_type: doc.court_type,
      outcome: doc.outcome,
      applied_articles: [],
      key_violations: [],
      legal_reasoning_summary: preview,
      decision_map: null,
      key_paragraphs: [],
      top_chunks: docChunks.map((c) => ({
        chunkIndex: c.chunk_index,
        text: c.excerpt,
      })),
      totalChunks: docChunks.length,
      max_score: Number(doc.max_score) || 0,
    };
  });
}

// в”Ђв”Ђв”Ђ FALLBACK: unified corpus RPC в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

async function searchViaFallbackRpc(
  sb: CorpusRpcClient,
  query: string,
  category: string | null,
  limitDocs: number,
): Promise<SearchResultDocument[]> {
  const { data, error } = await sb.rpc("search_legal_corpus_dual", {
    p_query_text: query,
    p_metric_embedding: null,
    p_qwen_embedding: null,
    p_content_domain: "practice",
    p_norm_status: "active",
    p_limit: limitDocs,
    p_metric_limit: 0,
    p_qwen_limit: 0,
    p_bm25_limit: Math.max(limitDocs, 30),
    p_effective_at: null,
  });

  if (error) throw new Error(`fallback corpus RPC: ${error.message}`);
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return [];

  return rows.map((r: Record<string, unknown>) => ({
    id: r.document_id as string,
    title: r.title as string,
    practice_category: ((r.source === "echr" ? "echr" : category) ?? "") as string,
    court_type: (r.source ?? "") as string,
    outcome: "",
    applied_articles: [],
    key_violations: [],
    legal_reasoning_summary: (r.text_snippet ?? null) as string | null,
    decision_map: null,
    key_paragraphs: [],
    top_chunks: [],
    totalChunks: 0,
    max_score: Number(r.score ?? 0) || 0,
  }));
}

// в”Ђв”Ђв”Ђ Helpers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * Normalize search query:
 * - Strip HTML tags
 * - Decode safe HTML entities (&quot; в†’ ", &amp; в†’ &, etc.)
 * - Remove control chars (keep \n \r \t)
 * - Collapse whitespace, cap at 200 chars
 * - Preserves Armenian (U+0531вЂ“U+058F), Cyrillic, and quotes for phrase-mode
 */
function normalizeSearchQuery(raw: string): string {
  let q = raw
    .replace(/<[^>]*>/g, "")                     // strip HTML tags
    .replace(HTML_ENTITY_RE, (m) => HTML_ENTITY_MAP[m.toLowerCase()] ?? m) // decode safe entities
    // deno-lint-ignore no-control-regex
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars (keep \n \r \t)
    .replace(/\s+/g, " ")                         // collapse whitespace
    .trim();

  if (q.length > 200) q = q.substring(0, 200);
  return q;
}

function jsonRes(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...defaultCorsHeaders, "Content-Type": "application/json" },
  });
}


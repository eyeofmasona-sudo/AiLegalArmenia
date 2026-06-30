import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";
import { log, warn, err } from "../_shared/safe-logger.ts";
import { handleCors, checkInternalAuth } from "../_shared/edge-security.ts";
import { applyTemporalValidation, buildTemporalWarnings, normalizeEffectiveDate } from "../_shared/temporal-validity-engine.ts";

type SearchTables = "kb" | "practice" | "both";

interface CorpusRow {
  chunk_id: string;
  document_id: string;
  version_id: string;
  doc_id: string | null;
  title: string | null;
  text_snippet: string | null;
  source_url: string | null;
  citation_anchor: string | null;
  language: string | null;
  source: string | null;
  content_domain: "knowledge_base" | "practice" | "unknown";
  norm_status: string;
  score: number;
  vector_score: number;
  fts_score: number;
  retrieval_model: string;
  retrieval_route: string;
  match_reason: string;
}

type RetrievalMode = "hybrid" | "vector" | "keyword_only" | "rpc_fallback";

serve(async (req) => {
  const cors = handleCors(req);
  if (cors.errorResponse) return cors.errorResponse;
  const corsHeaders = cors.corsHeaders!;

  const authErr = checkInternalAuth(req, corsHeaders);
  if (authErr) return authErr;

  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();

  try {
    const {
      query: rawQuery,
      tables = "both",
      limit = 10,
      threshold,
      reference_date,
    } = await req.json();

    if (!rawQuery || typeof rawQuery !== "string") {
      return json({ error: "Query is required", kb: [], practice: [] }, 400, corsHeaders);
    }

    const maxQueryLength = Number(Deno.env.get("MAX_QUERY_LENGTH")) || 2000;
    const maxResults = Number(Deno.env.get("MAX_RESULTS")) || 60;
    const query = rawQuery.length > maxQueryLength ? rawQuery.substring(0, maxQueryLength) : rawQuery;
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), maxResults);
    const searchTables = normalizeTables(tables);
    const semanticThreshold = normalizeThreshold(threshold);
    const normalizedReferenceDate = normalizeEffectiveDate(reference_date);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "public" }, global: { headers: { "x-statement-timeout": "8000" } } },
    );

    const metricEmbedding = await embedMetricQuery(query, requestId);
    // ECHR/qwen semantic arm is intentionally DISABLED (hard null), not dead code.
    // The corpus holds ~162k qwen3-embedding-0.6b ECHR vectors, but enabling semantic
    // retrieval over them requires TWO things that are not in place yet:
    //   1) a query-embedding service for qwen3-embedding-0.6b (no endpoint wired here), and
    //   2) a qwen ANN index in the DB (partial index WHERE model='qwen3-embedding-0.6b'
    //      AND status='success') — without it the qwen arm would seq-scan 162k vectors.
    // Until both exist, qwenEmbedding stays null, p_qwen_limit=0, and ECHR is served by
    // BM25/FTS only. To enable: add a qwen query-embedding fetch + the index, then set this.
    // See docs/VPS_EMBEDDINGS_DEPLOYMENT.md "Known gap H1".
    const qwenEmbedding: number[] | null = null;
    const warnings: string[] = [];
    if (!metricEmbedding) warnings.push("METRIC_EMBEDDING_UNAVAILABLE");
    const qwenWarning = qwenEmbedding ? undefined : "QWEN_QUERY_EMBEDDING_DISABLED";

    const { data, error } = await supabase.rpc("search_legal_corpus_dual", {
      p_query_text: query,
      p_metric_embedding: vectorArg(metricEmbedding),
      p_qwen_embedding: vectorArg(qwenEmbedding),
      p_content_domain: contentDomainFor(searchTables),
      p_norm_status: "active",
      p_limit: Math.max(safeLimit * 2, 20),
      p_metric_limit: metricEmbedding ? Math.max(safeLimit * 3, 30) : 0,
      p_qwen_limit: qwenEmbedding ? Math.max(safeLimit * 3, 30) : 0,
      p_bm25_limit: Math.max(safeLimit * 3, 30),
      p_effective_at: normalizedReferenceDate,
    });

    if (error) throw new Error(error.message);

    const rows = (Array.isArray(data) ? data as CorpusRow[] : [])
      .filter((row) => passesSemanticThreshold(row, semanticThreshold));
    const hasSemanticRows = rows.some(isSemanticRow);
    const hasKeywordRows = rows.some(isKeywordRow);
    const retrievalMode = resolveRetrievalMode(hasSemanticRows, hasKeywordRows);
    const semanticOk = Boolean(metricEmbedding);
    const kbRaw = rows
      .filter((row) => row.content_domain === "knowledge_base" && searchTables !== "practice")
      .map(mapKb)
      .slice(0, safeLimit);
    const practiceRaw = rows
      .filter((row) => row.content_domain === "practice" && searchTables !== "kb")
      .map(mapPractice)
      .slice(0, safeLimit);
    const validated = applyTemporalValidation([...kbRaw, ...practiceRaw], normalizedReferenceDate);
    const kb = validated.filter((row) => (row as { content_domain?: string }).content_domain !== "practice" && kbRaw.some((k) => k.chunk_id === row.chunk_id));
    const practice = validated.filter((row) => practiceRaw.some((p) => p.chunk_id === row.chunk_id));
    const temporalWarnings = buildTemporalWarnings(validated, normalizedReferenceDate);

    log("vector-search", "Corpus search complete", {
      requestId,
      kb_results: kb.length,
      practice_results: practice.length,
      embedding: metricEmbedding ? "metric" : "none",
      retrieval_mode: retrievalMode,
    });

    return json({
      kb,
      practice,
      retrieval_mode: retrievalMode,
      semantic_ok: semanticOk,
      semantic_error: warnings.length ? warnings.join("; ") : undefined,
      qwen_semantic_ok: Boolean(qwenEmbedding),
      qwen_semantic_error: qwenWarning,
      threshold_applied: semanticOk,
      threshold_value: semanticThreshold,
      rerank_ok: semanticOk,
      rerank_error: warnings.length ? warnings.join("; ") : undefined,
      temporal_warnings: temporalWarnings,
      request_id: requestId,
    }, 200, corsHeaders);
  } catch (error) {
    err("vector-search", "Search error", { error, requestId });
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({
      error: message,
      kb: [],
      practice: [],
      retrieval_mode: "rpc_fallback",
      semantic_ok: false,
      semantic_error: message,
      qwen_semantic_ok: false,
      qwen_semantic_error: "QWEN_QUERY_EMBEDDING_UNAVAILABLE",
      threshold_applied: false,
      rerank_ok: false,
      rerank_error: message,
      request_id: requestId,
    }, 500, corsHeaders);
  }
});

function normalizeTables(value: unknown): SearchTables {
  return value === "kb" || value === "practice" || value === "both" ? value : "both";
}

function contentDomainFor(tables: SearchTables) {
  if (tables === "kb") return "knowledge_base";
  if (tables === "practice") return "practice";
  return null;
}

function vectorArg(vector: number[] | null) {
  return Array.isArray(vector) && vector.length === 1024 ? `[${vector.join(",")}]` : null;
}

function normalizeThreshold(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.3;
  return Math.min(Math.max(n, 0), 1);
}

function isSemanticRow(row: CorpusRow) {
  return row.retrieval_route === "metric_hy" || row.retrieval_route === "qwen_echr" || Number(row.vector_score) > 0;
}

function isKeywordRow(row: CorpusRow) {
  const route = String(row.retrieval_route || "");
  return route.includes("bm25") || route.includes("fts") || row.match_reason === "fts" || Number(row.fts_score) > 0;
}

function passesSemanticThreshold(row: CorpusRow, threshold: number) {
  return !isSemanticRow(row) || Number(row.vector_score) >= threshold;
}

function resolveRetrievalMode(hasSemanticRows: boolean, hasKeywordRows: boolean): RetrievalMode {
  if (hasSemanticRows && hasKeywordRows) return "hybrid";
  if (hasSemanticRows) return "vector";
  if (hasKeywordRows) return "keyword_only";
  return "keyword_only";
}

/**
 * Edge functions run on Supabase infrastructure and CANNOT reach a VPS via
 * localhost or a private/LAN IP. A non-routable EMBEDDING_ENDPOINT is the #1
 * deployment trap: semantic search silently degrades to BM25. Detect and warn loudly.
 */
function isUnroutableEndpoint(url: string): boolean {
  return /(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?|:\/\/10\.|:\/\/192\.168\.|:\/\/172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
}

async function embedMetricQuery(text: string, requestId: string): Promise<number[] | null> {
  const endpoint = Deno.env.get("EMBEDDING_ENDPOINT");
  if (!endpoint) return null;
  if (isUnroutableEndpoint(endpoint)) {
    warn("vector-search", "EMBEDDING_ENDPOINT is NOT routable from Supabase Edge (localhost/private IP) — set a public HTTPS URL in Edge Secrets; semantic search is falling back to BM25", { requestId, endpoint });
    return null;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = Deno.env.get("EMBEDDING_API_KEY");
  if (apiKey) headers["X-API-Key"] = apiKey;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(`${endpoint.replace(/\/+$/, "")}/embed/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ texts: text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      warn("vector-search", "Embedding endpoint failed", { requestId, status: res.status });
      return null;
    }
    const payload = await res.json() as { vectors?: number[][] };
    const vector = payload.vectors?.[0];
    return Array.isArray(vector) && vector.length === 1024 ? vector : null;
  } catch (error) {
    warn("vector-search", "Embedding endpoint unavailable", { requestId, error: String(error) });
    return null;
  }
}

function mapKb(row: CorpusRow) {
  return {
    id: row.document_id,
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    title: row.title || row.doc_id || "Untitled",
    content_text: row.text_snippet || "",
    category: row.source || "legal",
    source_name: row.source || null,
    version_date: null,
    citation_anchor: row.citation_anchor,
    norm_status: row.norm_status,
    match_reason: row.match_reason,
    similarity: row.score,
    vector_score: row.vector_score,
    fts_score: row.fts_score,
    retrieval_model: row.retrieval_model,
    retrieval_route: row.retrieval_route,
    rank: row.fts_score,
    score: row.score,
  };
}

function mapPractice(row: CorpusRow) {
  return {
    id: row.document_id,
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    title: row.title || row.doc_id || "Untitled",
    content_text: row.text_snippet || "",
    content_snippet: row.text_snippet || "",
    practice_category: row.source === "echr" ? "echr" : "court_decision",
    court_type: row.source || "",
    outcome: "",
    legal_reasoning_summary: row.text_snippet || "",
    decision_date: null,
    case_number: row.citation_anchor || undefined,
    court_name: row.source || undefined,
    citation_anchor: row.citation_anchor || undefined,
    norm_status: row.norm_status,
    match_reason: row.match_reason,
    similarity: row.score,
    vector_score: row.vector_score,
    fts_score: row.fts_score,
    retrieval_model: row.retrieval_model,
    retrieval_route: row.retrieval_route,
    relevance_score: row.score,
    score: row.score,
  };
}

function json(body: Record<string, unknown>, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

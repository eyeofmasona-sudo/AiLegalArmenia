// =============================================================================
// UNIFIED RAG SEARCH — Single module for all KB + Practice hybrid search
// Used by: ai-analyze, legal-chat, multi-agent-analyze, generate-complaint,
//          generate-document, vector-search
// =============================================================================
//
// INDEX SEPARATION RULE (MANDATORY):
// 1. Normative KB (knowledge_base) → laws/legislation ONLY
// 2. Practice corpus → RA court / ECHR materials from unified corpus
// 3. ECHR KB → ECHR decisions ONLY (filtered by practice_category='echr')
// NEVER mix indexes across these boundaries.
// NEVER embed entire documents for generation — use precedent_units only.
// When Practice results contain key_paragraphs (precedent_units), prefer them
// over full content_text for AI prompt injection.
// =============================================================================

import type { KBSearchResult, PracticeSearchResult, RetrievalMode, VectorSearchResponse } from "./rag-types.ts";
import { callInternalFunction } from "./edge-security.ts";
import { recordAiMetric } from "./ai-metrics.ts";
import { buildSourceHierarchyContext, rankLegalSources, type SourceHierarchyContext } from "./source-hierarchy-engine.ts";
import { applyTemporalValidation, buildTemporalWarnings } from "./temporal-validity-engine.ts";
import { buildCourtPracticeContext, type CourtPracticeContext } from "./court-practice-engine.ts";

// ─── Env-configurable guardrails (safe defaults, override via env) ──────────
function envNumber(name: string, fallback: number): number {
  try {
    return Number(Deno.env.get(name)) || fallback;
  } catch {
    return fallback;
  }
}

const MAX_QUERY_LENGTH = envNumber("MAX_QUERY_LENGTH", 2000);
const MAX_RESULTS = envNumber("MAX_RESULTS", 60);
const MAX_KB_CHUNKS_RETURNED = envNumber("MAX_KB_CHUNKS_RETURNED", 40);
const MAX_PRACTICE_CHUNKS_RETURNED = envNumber("MAX_PRACTICE_CHUNKS_RETURNED", 40);

// ─── Configuration ──────────────────────────────────────────────────────────

export interface RAGSearchOptions {
  /** Supabase client (service_role) */
  supabase: SupabaseClient;
  /** Supabase URL for vector-search edge function calls */
  supabaseUrl: string;
  /** Service role key for auth */
  supabaseKey: string;
  /** The user query to search */
  query: string;
  /** Reference date for temporal legislation filtering (ISO string) */
  referenceDate?: string | null;
  /** Practice category filter */
  category?: string | null;
  /** Incoming x-request-id to propagate through internal calls */
  requestId?: string;
  /** Similarity threshold for semantic vector branches (default 0.3) */
  threshold?: number;
  /** Restrict KB results to these categories only */
  categoryAllowlist?: string[];
}

export interface RAGKBOptions extends RAGSearchOptions {
  /** Max results to return (default: 8) */
  limit?: number;
  /** Max content chars per result (default: 4000) */
  snippetLength?: number;
}

export interface RAGPracticeOptions extends RAGSearchOptions {
  /** Max results to return (default: 5) */
  limit?: number;
  /** Max content chars per result (default: full text) */
  snippetLength?: number;
}

export interface RAGResult<T> {
  results: T[];
  sources: Array<{ title: string; category?: string; source_name?: string }>;
  /** Telemetry: retrieval mode used */
  retrieval_mode?: RetrievalMode;
  /** Whether semantic/vector retrieval was available */
  semantic_ok?: boolean;
  /** Semantic/vector availability error */
  semantic_error?: string;
  /** @deprecated Compatibility alias for semantic_ok; no AI reranker is used */
  rerank_ok?: boolean;
  /** @deprecated Compatibility alias for semantic_error */
  rerank_error?: string;
  source_hierarchy?: SourceHierarchyContext;
  court_practice?: CourtPracticeContext;
  temporal_warnings?: string[];
}

type SupabaseError = { message?: string } | null;
type SupabaseResult<T = unknown> = { data: T | null; error: SupabaseError };
type SupabaseClient = {
  from: (table: string) => unknown;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<SupabaseResult>;
};

// ─── Keyword extraction ─────────────────────────────────────────────────────

// ─── Case Number Detection ──────────────────────────────────────────────────

/**
 * Lightweight Armenian case number detector.
 * Matches patterns like ԵԿԴ/0229/01/16 in user queries.
 * Returns normalized case number (spaces around "/" removed) or null.
 */
const CASE_NUMBER_QUERY_RE = /[\u0531-\u0556]{1,6}\s*\/\s*\d{2,6}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}/u;

export function detectCaseNumberInQuery(query: string): string | null {
  const m = query.match(CASE_NUMBER_QUERY_RE);
  if (!m) return null;
  return m[0].replace(/\s*\/\s*/g, "/");
}

/** Extract and sanitize search keywords from query text */
export function extractKeywords(text: string, maxCount = 10): string[] {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^[0-9]+$/.test(w))
    .slice(0, maxCount);
}

/** Sanitize keyword for Postgrest ILIKE (remove special chars + PostgREST operators) */
export function sanitizeForPostgrest(input: string): string {
  return input
    .replace(/[%_]/g, "")
    .replace(/[(),.*\\;:!'"]/g, "")
    .replace(/\b(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|not|or|and|fts|plfts|phfts|wfts)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
}

/** Truncate query to MAX_QUERY_LENGTH */
export function clampQuery(raw: string): string {
  return raw.length > MAX_QUERY_LENGTH ? raw.substring(0, MAX_QUERY_LENGTH) : raw;
}

// ─── Vector Search Helper ───────────────────────────────────────────────────

/** Result from callVectorSearch including telemetry */
interface VectorSearchCallResult extends VectorSearchResponse {
  _failed: boolean;
  _error?: string;
}

/** Call the vector-search edge function — surfaces errors explicitly */
async function callVectorSearch(
  supabaseUrl: string,
  query: string,
  tables: "kb" | "practice" | "both",
  opts: { limit?: number; category?: string | null; referenceDate?: string | null; requestId?: string; threshold?: number } = {}
): Promise<VectorSearchCallResult> {
  const effectiveThreshold = opts.threshold ?? 0.3;
  console.log(`[RAG] Using semantic threshold: ${effectiveThreshold}`);
  try {
    // Internal calls authenticate via x-internal-key only (set by callInternalFunction).
    // Authorization header is intentionally omitted: vector-search creates its
    // own service_role client server-side, so forwarding a service-role key over
    // HTTP would be an unnecessary secret exposure.
    const response = await callInternalFunction(
      `${supabaseUrl}/functions/v1/vector-search`,
      {
        query,
        tables,
        category: opts.category || undefined,
        limit: opts.limit || 10,
        threshold: effectiveThreshold,
        reference_date: opts.referenceDate || undefined,
      },
      {
        requestId: opts.requestId,
        timeoutMs: 60_000,
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      const msg = `vector-search returned ${response.status}: ${errorText.substring(0, 200)}`;
      console.warn(`[rag-search] ${msg}`);
      return { kb: [], practice: [], _failed: true, _error: msg };
    }

    const data = await response.json();
    return {
      kb: data.kb || [],
      practice: data.practice || [],
      retrieval_mode: data.retrieval_mode,
      semantic_ok: data.semantic_ok === true,
      semantic_error: data.semantic_error,
      qwen_semantic_ok: data.qwen_semantic_ok === true,
      qwen_semantic_error: data.qwen_semantic_error,
      threshold_applied: data.threshold_applied === true,
      threshold_value: data.threshold_value,
      rerank_ok: data.rerank_ok ?? data.semantic_ok,
      rerank_error: data.rerank_error ?? data.semantic_error,
      request_id: data.request_id,
      _failed: false,
    };
  } catch (fetchErr) {
    const msg = `vector-search fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
    console.error(`[rag-search] ${msg}`);
    return { kb: [], practice: [], _failed: true, _error: msg };
  }
}

// ─── Keyword Relevance Scoring ──────────────────────────────────────────────

interface ScoredItem {
  id: string;
  title: string;
  score: number;
  [key: string]: unknown;
}

/** Score items by keyword overlap: title=3, reasoning/summary=2, content=1 */
function scoreByKeywords<T extends { id: string; title: string; content_text?: string; legal_reasoning_summary?: string }>(
  items: T[],
  keywords: string[]
): (T & { score: number })[] {
  return items.map((r) => {
    let score = 0;
    const titleLower = (r.title || "").toLowerCase();
    const contentLower = (r.content_text || "").toLowerCase();
    const reasoningLower = (r.legal_reasoning_summary || "").toLowerCase();
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (titleLower.includes(kwLower)) score += 3;
      if (reasoningLower.includes(kwLower)) score += 2;
      if (contentLower.includes(kwLower)) score += 1;
    }
    return { ...r, score };
  });
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/** Merge arrays of items by id, preserving insertion order (first wins) */
function dedup<T extends { id: string }>(
  ...arrays: T[][]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const arr of arrays) {
    for (const item of arr) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out;
}

// ─── Knowledge Base Search ──────────────────────────────────────────────────

/**
 * Hybrid KB search: vector + keyword ILIKE + FTS RPC fallback.
 * Returns deduplicated, scored, trimmed results.
 */
export async function searchKB(opts: RAGKBOptions): Promise<RAGResult<KBSearchResult>> {
  const { supabaseUrl, referenceDate } = opts;
  const query = clampQuery(opts.query);
  const limit = Math.min(opts.limit ?? 8, MAX_KB_CHUNKS_RETURNED);
  const snippetLen = opts.snippetLength ?? 4000;
  const keywords = extractKeywords(query);
  const safeKeywords = keywords.map(sanitizeForPostgrest).filter((k) => k.length > 0);

  // Phase 1: Parallel vector + keyword search
  const vectorPromise = callVectorSearch(supabaseUrl, query, "kb", {
    limit: 10,
    referenceDate,
    requestId: opts.requestId,
    threshold: opts.threshold,
  });

  // Apply category allowlist filtering
  if (opts.categoryAllowlist && opts.categoryAllowlist.length > 0) {
    console.log(`[RAG] Category filter applied:`, opts.categoryAllowlist);
  }

  const keywordPromise = Promise.resolve([] as KBSearchResult[]);

  const [vectorResults, keywordResults] = await Promise.all([vectorPromise, keywordPromise]);

  // Vector results get semantic-based rank — post-filter by categoryAllowlist
  const allowlist = opts.categoryAllowlist;
  const vectorItems = (vectorResults.kb || [])
    .filter((r: KBSearchResult) => !allowlist || allowlist.length === 0 || allowlist.includes(r.category ?? ""))
    .map((r: KBSearchResult) => ({
      ...r,
      score: (r.similarity || 0) * 10,
    }));

  // Keyword results get keyword-relevance score
  const scoredKeyword = scoreByKeywords(keywordResults, keywords);

  // Merge: vector first (semantic), then keyword
  const merged = dedup(vectorItems, scoredKeyword);

  // Sort by score descending, trim
  const sorted = merged
    .sort((a, b) => (b.score ?? b.rank ?? 0) - (a.score ?? a.rank ?? 0))
    .slice(0, limit);

  // Trim content and apply deterministic temporal validation after retrieval.
  const temporalChecked = applyTemporalValidation(sorted.map((r) => ({
    ...r,
    content_text: (r.content_text || "").substring(0, snippetLen),
  })), referenceDate);
  const trimmed = rankLegalSources(temporalChecked) as unknown as KBSearchResult[];

  const sources = trimmed.map((r) => ({
    title: r.title,
    category: r.category,
    source_name: r.source_name || "RA Legal Database",
  }));

  // Propagate telemetry from vector-search
  const semanticOk = !vectorResults._failed && vectorResults.semantic_ok === true;
  const retrievalMode = vectorResults._failed
    ? (merged.length > 0 ? "keyword_only" as const : "rpc_fallback" as const)
    : (vectorResults.retrieval_mode || "keyword_only" as const);

  if (vectorResults._failed) {
    console.warn(`[rag-search/searchKB] Retrieval failed: ${vectorResults._error}`);
  }

  return {
    results: trimmed,
    sources,
    retrieval_mode: retrievalMode,
    semantic_ok: semanticOk,
    semantic_error: vectorResults._error || vectorResults.semantic_error,
    rerank_ok: semanticOk,
    rerank_error: vectorResults._error || vectorResults.semantic_error,
    source_hierarchy: buildSourceHierarchyContext(trimmed, { temporal_context: { effective_at: referenceDate || null } }),
    temporal_warnings: buildTemporalWarnings(trimmed, referenceDate),
  };
}

// ─── Legal Practice Search ──────────────────────────────────────────────────

/**
 * Hybrid practice search: vector + keyword ILIKE + FTS RPC fallback.
 * Returns deduplicated, scored, trimmed results.
 */
export async function searchPractice(opts: RAGPracticeOptions): Promise<RAGResult<PracticeSearchResult>> {
  const { supabaseUrl, category } = opts;
  const query = clampQuery(opts.query);
  const limit = Math.min(opts.limit ?? 5, MAX_PRACTICE_CHUNKS_RETURNED);
  const keywords = extractKeywords(query, 8);
  const safeKeywords = keywords.map(sanitizeForPostgrest).filter((k) => k.length > 0);

  // ── Case number detection: boost exact case_number matches ──
  const detectedCaseNumber = detectCaseNumberInQuery(query);
  if (detectedCaseNumber) {
    console.log(`[rag-search] Detected case_number in query: ${detectedCaseNumber}`);
  }

  // Phase 1: Parallel vector + keyword + case_number lookup
  const vectorPromise = callVectorSearch(supabaseUrl, query, "practice", {
    limit: 10,
    category,
    requestId: opts.requestId,
    threshold: opts.threshold,
  });

  const keywordPromise = Promise.resolve([] as PracticeSearchResult[]);
  const caseNumberPromise = Promise.resolve([] as PracticeSearchResult[]);

  const [vectorResults, keywordResults, caseNumberResults] = await Promise.all([
    vectorPromise, keywordPromise, caseNumberPromise,
  ]);

  // Normalize vector results (content_snippet → content_text)
  const vectorItems = (vectorResults.practice || []).map((r: PracticeSearchResult) => ({
    ...r,
    content_text: r.content_text || r.content_snippet || "",
    score: (r.similarity || 0) * 10,
  }));

  // Normalize DB field names to PracticeSearchResult shape
  const normalizedKeyword = keywordResults.map((r: PracticeSearchResult & { case_number_anonymized?: string }) => ({
    ...r,
    case_number: r.case_number_anonymized as string | undefined,
  })) as PracticeSearchResult[];

  const scoredKeyword = scoreByKeywords(
    normalizedKeyword as Array<PracticeSearchResult & { legal_reasoning_summary?: string }>,
    keywords
  );

  // Case number results go first (highest priority)
  const merged = dedup(caseNumberResults, vectorItems, scoredKeyword);

  // Sort, trim, and apply deterministic temporal validation after retrieval.
  const temporalChecked = applyTemporalValidation(merged
    .sort((a, b) => (b.score ?? b.rank ?? b.relevance_rank ?? 0) - (a.score ?? a.rank ?? a.relevance_rank ?? 0))
    .slice(0, limit), opts.referenceDate);
  const sorted = rankLegalSources(temporalChecked) as unknown as PracticeSearchResult[];

  const sources = sorted.map((r) => ({
    title: r.title,
    category: r.practice_category,
  }));

  const semanticOk = !vectorResults._failed && vectorResults.semantic_ok === true;
  const retrievalMode = vectorResults._failed
    ? (merged.length > 0 ? "keyword_only" as const : "rpc_fallback" as const)
    : (vectorResults.retrieval_mode || "keyword_only" as const);

  if (vectorResults._failed) {
    console.warn(`[rag-search/searchPractice] Retrieval failed: ${vectorResults._error}`);
  }

  return {
    results: sorted,
    sources,
    retrieval_mode: retrievalMode,
    semantic_ok: semanticOk,
    semantic_error: vectorResults._error || vectorResults.semantic_error,
    rerank_ok: semanticOk,
    rerank_error: vectorResults._error || vectorResults.semantic_error,
    source_hierarchy: buildSourceHierarchyContext(sorted, { temporal_context: { effective_at: opts.referenceDate || null } }),
    temporal_warnings: buildTemporalWarnings(sorted, opts.referenceDate),
  };
}

// ─── Formatters ─────────────────────────────────────────────────────────────

/** Format KB results into context string for AI prompt */
export function formatKBContext(results: KBSearchResult[], snippetLength = 4000): string {
  if (results.length === 0) return "";
  return results
    .map((r, i) => {
      const lines = [
        `[${i + 1}] ${r.title} (${r.category}, ${r.source_name || "N/A"})`,
        `ID: ${r.id}`,
      ];
      if (r.chunk_id) lines.push(`ChunkID: ${r.chunk_id}`);
      if (r.citation_anchor) lines.push(`CitationAnchor: ${r.citation_anchor}`);
      if (r.norm_status) lines.push(`Status: ${r.norm_status}`);
      if (r.effective_from || r.effective_to) {
        lines.push(`Effective: ${r.effective_from || "unknown"} to ${r.effective_to || "open"}`);
      }
      lines.push((r.content_text || "").substring(0, snippetLength));
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

/** Format practice results into structured block for AI prompt.
 * Strict format: [PRACTICE]...[/PRACTICE] with consistent field labels.
 * Prefers precedent_units (key_paragraphs) over full text per INDEX SEPARATION RULE.
 */
export function formatPracticeContext(results: PracticeSearchResult[], _fullText = true): string {
  if (results.length === 0) return "";

  return results
    .map((r) => {
      // Determine source: ECHR vs RA
      const isEchr = r.practice_category === "echr" || r.court_type === "echr";
      const source = isEchr ? "ECHR" : r.court_type ? "RA" : "UNKNOWN";

      // Build excerpt: prefer key_paragraphs, then legal_reasoning_summary, then content
      let excerpt = "";
      const keyParas = r.key_paragraphs;
      if (keyParas && Array.isArray(keyParas) && keyParas.length > 0) {
        excerpt = keyParas.slice(0, 6).map((u: Record<string, unknown>, idx: number) => {
          const ruleText = u.rule_text || u.holding || "";
          const quote = u.quote || u.exact_quote || "";
          return `  ${idx + 1}) ${ruleText}${quote ? ` «${quote}»` : ""}`;
        }).join("\n");
      } else {
        excerpt = (r.content_snippet || r.content_text || "").substring(0, 1500);
      }

      // Build lines, omitting empty values (except ID)
      const lines: string[] = ["[PRACTICE]"];
      lines.push(`Source: ${source}`);
      if (r.practice_category) lines.push(`Category: ${r.practice_category}`);
      if (r.court_type) lines.push(`CourtType: ${r.court_type}`);
      if (r.court_name) lines.push(`Court: ${r.court_name}`);
      lines.push(`Case: ${r.title}`);
      if (r.decision_date) lines.push(`Date: ${r.decision_date}`);
      if (r.case_number) lines.push(`CaseNo: ${r.case_number}`);
      lines.push(`ID: ${r.id || "unknown"}`);
      if (r.chunk_id) lines.push(`ChunkID: ${r.chunk_id}`);
      if (r.citation_anchor) lines.push(`CitationAnchor: ${r.citation_anchor}`);
      if (r.norm_status) lines.push(`Status: ${r.norm_status}`);
      if (r.effective_from || r.effective_to) {
        lines.push(`Effective: ${r.effective_from || "unknown"} to ${r.effective_to || "open"}`);
      }
      if (excerpt) {
        lines.push("Excerpt:");
        lines.push(excerpt);
      }
      lines.push("[/PRACTICE]");

      return lines.join("\n");
    })
    .join("\n\n");
}

/** Build temporal disclaimer for RAG context */
export function temporalDisclaimer(referenceDate: string | null | undefined, dateAssumed: boolean): string {
  if (dateAssumed) {
    return "\n\n[TEMPORAL NOTE: No case date provided. Legislation shown is the currently effective version. If events occurred on a different date, applicable law may differ. State this assumption explicitly.]";
  }
  if (referenceDate) {
    return `\n\n[TEMPORAL NOTE: Legislation filtered for versions effective as of ${referenceDate}.]`;
  }
  return "";
}

// ─── Anchor-Based Precise Lookup ────────────────────────────────────────────

import type { NormAnchor } from "./norm-ref-extractor.ts";

/** Category mapping per case_type for anchor lookups */
const CATEGORY_MAP: Record<string, string[]> = {
  criminal: ["criminal_code", "criminal_procedure_code", "constitution", "echr"],
  civil: ["civil_code", "civil_procedure_code", "constitution"],
  administrative: ["administrative_code", "administrative_procedure_code", "administrative_violations_code", "constitution"],
};

export interface LookupByAnchorsParams {
  anchors: NormAnchor[];
  caseType?: string | null;
  referenceDate?: string | null;
  supabase: SupabaseClient;
}

export interface AnchorSource {
  id: string;
  chunk_id?: string;
  document_id?: string;
  title: string;
  category: string;
  source_name: string;
  content_text: string;
  effective_from?: string | null;
  effective_to?: string | null;
  article_number: string | null;
  anchor_raw: string;
}

type LookupCitationRow = {
  chunk_id?: string | null;
  document_id?: string | null;
  title_hy?: string | null;
  title_ru?: string | null;
  canonical_key?: string | null;
  arlis_doc_id?: string | null;
  text?: string | null;
  unit_number?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
};

/**
 * Precise KB lookup by extracted norm anchors (article numbers / act names).
 * No semantic search — direct DB queries only.
 * Returns sources compatible with Citation Guard format.
 */
export async function lookupByAnchors(params: LookupByAnchorsParams): Promise<AnchorSource[]> {
  const MAX_ANCHORS = Number(Deno.env.get("MAX_ANCHORS")) || 50;
  const { supabase } = params;
  const anchors = (params.anchors || []).slice(0, MAX_ANCHORS);
  if (anchors.length === 0) return [];

  const seen = new Set<string>();
  const results: AnchorSource[] = [];

  for (const anchor of anchors) {
    if (!anchor.article) continue;

    const citation = [anchor.act_name, anchor.article].filter(Boolean).join(" ");
    const { data, error } = await supabase.rpc("lookup_by_citation", {
      p_citation: citation || anchor.raw,
      p_limit: 10,
      p_effective_at: params.referenceDate || null,
    });
    if (error) {
      console.warn(`[lookupByAnchors] RPC error for article=${anchor.article}:`, error.message);
      continue;
    }

    if (Array.isArray(data)) {
      for (const row of data as LookupCitationRow[]) {
        const id = row.document_id || row.chunk_id;
        if (!id) continue;
        const key = `${row.document_id || ""}:${row.chunk_id || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          id,
          document_id: row.document_id || undefined,
          chunk_id: row.chunk_id || undefined,
          title: row.title_hy || row.title_ru || row.canonical_key || "Untitled",
          category: "legal",
          source_name: row.arlis_doc_id || "Unified legal corpus",
          content_text: (row.text || "").substring(0, 4000),
          effective_from: row.effective_from || null,
          effective_to: row.effective_to || null,
          article_number: row.unit_number || anchor.article,
          anchor_raw: anchor.raw,
        });
      }
    }
  }

  return applyTemporalValidation(results, params.referenceDate)
    .filter((source) => source.temporal_valid)
    .map((source) => ({
      id: source.id,
      document_id: source.document_id,
      chunk_id: source.chunk_id,
      title: source.title,
      category: source.category,
      source_name: source.source_name,
      content_text: source.content_text,
      effective_from: source.effective_from || undefined,
      effective_to: source.effective_to || undefined,
      article_number: source.article_number,
      anchor_raw: source.anchor_raw,
    }));
}

// ─── Convenience: Full dual-bucket search ───────────────────────────────────

export interface DualRAGResult {
  kbContext: string;
  practiceContext: string;
  kbResults: KBSearchResult[];
  practiceResults: PracticeSearchResult[];
  sources: Array<{ title: string; category?: string; source_name?: string }>;
  /** Telemetry: overall retrieval mode */
  retrieval_mode: RetrievalMode;
  /** Whether semantic/vector retrieval was available in all requested buckets */
  semantic_ok: boolean;
  /** Aggregated semantic/vector errors if any */
  semantic_error?: string;
  /** @deprecated Compatibility alias for semantic_ok; no AI reranker is used */
  rerank_ok: boolean;
  /** @deprecated Compatibility alias for semantic_error */
  rerank_error?: string;
  source_hierarchy?: SourceHierarchyContext;
  court_practice?: CourtPracticeContext;
  temporal_warnings?: string[];
}

/**
 * One-call dual-bucket RAG: searches both KB and Practice in parallel,
 * returns formatted context strings ready for AI prompt injection.
 */
export async function dualSearch(opts: RAGSearchOptions & {
  kbLimit?: number;
  practiceLimit?: number;
  kbSnippetLength?: number;
  fullPracticeText?: boolean;
  categoryAllowlist?: string[];
}): Promise<DualRAGResult> {
  // Clamp query at entry point
  const clampedQuery = clampQuery(opts.query);
  const optsWithClamp = { ...opts, query: clampedQuery };
  console.log("[RAG] Query length:", clampedQuery.length, "(clamped from", opts.query.length, ")");

  const [kb, practice] = await Promise.all([
    searchKB({
      ...optsWithClamp,
      limit: Math.min(opts.kbLimit ?? 8, MAX_KB_CHUNKS_RETURNED),
      snippetLength: opts.kbSnippetLength ?? 4000,
    }),
    searchPractice({
      ...optsWithClamp,
      limit: Math.min(opts.practiceLimit ?? 5, MAX_PRACTICE_CHUNKS_RETURNED),
    }),
  ]);

  const totalResults = kb.results.length + practice.results.length;
  console.log("[RAG] Results after threshold:", totalResults);

  // Aggregate telemetry
  const semanticOk = (kb.semantic_ok === true) && (practice.semantic_ok === true);
  const errors = [kb.semantic_error, practice.semantic_error].filter(Boolean).join("; ");
  const retrievalMode = aggregateRetrievalMode(kb.retrieval_mode, practice.retrieval_mode);

  if (!semanticOk) {
    console.warn(`[rag-search/dualSearch] Semantic degradation: ${errors}`);
  }

  // ── Fire-and-forget retrieval telemetry ──
  // Uses record_ai_metric RPC; no PII.
  try {
    const sanitizedError = errors
      ? errors.replace(/[\n\r]/g, " ").substring(0, 200)
      : null;
    recordAiMetric(opts.supabase, {
      fnName: "rag-retrieval",
      status: semanticOk ? "success" : "failed",
      errorMessage: sanitizedError,
    }).then(() => { /* fire-and-forget */ }).catch((e: unknown) => {
      console.warn("[rag-search] AI metric log failed:", e);
    });
  } catch (_) {
    // Never block search results for telemetry failures
  }

  return {
    kbContext: formatKBContext(kb.results, opts.kbSnippetLength ?? 4000),
    practiceContext: formatPracticeContext(practice.results, opts.fullPracticeText ?? true),
    kbResults: kb.results,
    practiceResults: practice.results,
    sources: [...kb.sources, ...practice.sources],
    retrieval_mode: retrievalMode,
    semantic_ok: semanticOk,
    semantic_error: errors || undefined,
    rerank_ok: semanticOk,
    rerank_error: errors || undefined,
    source_hierarchy: buildSourceHierarchyContext([...kb.results, ...practice.results], { temporal_context: { effective_at: opts.referenceDate || null } }),
    court_practice: buildCourtPracticeContext(practice.results, { effective_at: opts.referenceDate || null }),
    temporal_warnings: buildTemporalWarnings([...kb.results, ...practice.results], opts.referenceDate),
  };
}

function aggregateRetrievalMode(...modes: Array<RetrievalMode | undefined>): RetrievalMode {
  if (modes.includes("hybrid")) return "hybrid";
  if (modes.includes("vector")) return "vector";
  if (modes.includes("keyword_only")) return "keyword_only";
  return "rpc_fallback";
}

// =============================================================================
// SHARED RAG TYPES — Single source of truth for search result shapes
// =============================================================================

/** Knowledge-base document returned by vector-search / unified corpus RPC */
export interface KBSearchResult {
  id: string;
  chunk_id?: string;
  document_id?: string;
  title: string;
  content_text: string;
  category?: string;
  source_name?: string;
  version_date?: string;
  citation_anchor?: string;
  norm_status?: string;
  effective_from?: string | null;
  effective_to?: string | null;
  similarity?: number;
  vector_score?: number;
  fts_score?: number;
  retrieval_model?: string;
  retrieval_route?: string;
  rank?: number;
  score?: number;
}

/** Legal-practice document returned by vector-search / unified corpus RPC */
export interface PracticeSearchResult {
  id: string;
  chunk_id?: string;
  document_id?: string;
  title: string;
  content_text?: string;
  content_snippet?: string;
  practice_category?: string;
  court_type?: string;
  outcome?: string;
  applied_articles?: string[] | Record<string, unknown>[];
  key_violations?: string[];
  legal_reasoning_summary?: string;
  /** ISO date string (YYYY-MM-DD) of the court decision */
  decision_date?: string;
  /** Anonymized case number */
  case_number?: string;
  /** Court name (Armenian) */
  court_name?: string;
  citation_anchor?: string;
  norm_status?: string;
  effective_from?: string | null;
  effective_to?: string | null;
  /** Precedent unit paragraphs */
  key_paragraphs?: Record<string, unknown>[];
  similarity?: number;
  vector_score?: number;
  fts_score?: number;
  retrieval_model?: string;
  retrieval_route?: string;
  rank?: number;
  relevance_rank?: number;
  relevance_score?: number;
  score?: number;
}

export type RetrievalMode = "hybrid" | "vector" | "keyword_only" | "rpc_fallback";

/**
 * Single item in the unified merged result list returned by kb-unified-search.
 * Combines KB documents and legal-practice records into one ranked stream.
 */
export interface MergedItem {
  /** Which collection this result came from */
  source: "kb" | "practice";
  id: string;
  title: string;
  /** Hybrid score: 0.6 × FTS_normalized + 0.4 × cosine_similarity (range 0–1) */
  normalized_score: number;
  /** Raw FTS rank before normalization */
  raw_score: number;
  /** Truncated content preview (≤ MAX_PREVIEW_CHARS characters) */
  preview: string;
  /** Source-specific metadata (category, court_type, outcome, etc.) */
  meta: Record<string, unknown>;
}

/** Shape returned by the vector-search edge function */
export interface VectorSearchResponse {
  kb: KBSearchResult[];
  practice: PracticeSearchResult[];
  /** Unified ranked list merging KB + practice results by hybrid score */
  merged?: MergedItem[];
  /** Telemetry: which retrieval methods produced results */
  retrieval_mode?: RetrievalMode;
  /** Whether semantic/vector retrieval was available for this request */
  semantic_ok?: boolean;
  /** Error message if semantic/vector retrieval was unavailable or failed */
  semantic_error?: string;
  /** Whether Qwen/ECHR semantic retrieval was available for this request */
  qwen_semantic_ok?: boolean;
  /** Error message if Qwen/ECHR semantic retrieval was unavailable */
  qwen_semantic_error?: string;
  /** Whether a semantic threshold was applied to vector branches */
  threshold_applied?: boolean;
  threshold_value?: number;
  /** @deprecated Compatibility alias for semantic_ok; no AI reranker is used */
  rerank_ok?: boolean;
  /** @deprecated Compatibility alias for semantic_error */
  rerank_error?: string;
  /** Request tracing ID */
  request_id?: string;
}

/** OpenAI-compatible chat completion message content part */
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

/** Parsed multi-agent analysis result */
export interface MultiAgentParsedResult {
  summary: string;
  analysis: string;
  findings: unknown[];
  evidenceItems: unknown[];
  [key: string]: unknown;
}

/** Error shape thrown by requireAdmin / edge auth guards */
export interface EdgeFunctionError {
  status: number;
  code: string;
  message: string;
}

/** Supabase joined reminder with profile */
export interface ReminderWithProfile {
  id: string;
  title: string;
  event_datetime: string;
  reminder_type: string;
  description?: string | null;
  profiles: {
    telegram_chat_id: string | null;
    notification_preferences: { telegram?: boolean } | null;
  } | null;
}

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type PracticeCategory = "criminal" | "civil" | "administrative" | "echr" | "constitutional" | "bankruptcy";
export type CourtType = "first_instance" | "appeal" | "cassation" | "constitutional" | "echr";
export type Outcome = "granted" | "rejected" | "partial" | "remanded" | "discontinued";

export interface DecisionMap {
  legal_question?: string;
  holding?: string;
  tests_or_criteria?: string;
  application_to_facts?: string;
  remedy?: string;
  references?: string[];
}

export interface KeyParagraph {
  tag: string;
  chunkIdx: number;
  excerpt?: string;
}

export interface TopChunk {
  chunkIndex: number;
  text: string;
}

export interface KBDocument {
  id: string;
  title: string;
  practice_category: PracticeCategory;
  court_type: CourtType;
  outcome: Outcome;
  applied_articles: Array<{ code: string; articles: string[] }>;
  key_violations: string[];
  legal_reasoning_summary: string | null;
  decision_map: DecisionMap | null;
  key_paragraphs: KeyParagraph[];
  top_chunks: TopChunk[];
  totalChunks: number;
  returnedChunks?: number;
  max_score?: number;
}

export interface KBChunk {
  id: string;
  title: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  meta?: {
    idx: number;
    start: number;
    end: number;
    label?: string;
  };
}

interface UseKBState {
  documents: KBDocument[];
  isSearching: boolean;
  searchError: string | null;
  loadedChunks: Map<string, KBChunk>; // key: `${docId}:${chunkIndex}`
  isLoadingChunk: boolean;
  chunkError: string | null;
}

export function useLegalPracticeKB() {
  const [state, setState] = useState<UseKBState>({
    documents: [],
    isSearching: false,
    searchError: null,
    loadedChunks: new Map(),
    isLoadingChunk: false,
    chunkError: null,
  });

  /**
   * Search KB documents
   */
  const searchKB = useCallback(async (
    query: string,
    category?: PracticeCategory | null,
    limitDocs: number = 5,
    limitChunksPerDoc: number = 3
  ) => {
    setState((s) => ({ ...s, isSearching: true, searchError: null }));

    try {
      // Run edge-function search + chunk-RPC search in parallel
      const edgePromise = supabase.functions.invoke("kb-search", {
        body: {
          query,
          category: category || null,
          limitDocs,
          limitChunksPerDoc,
        },
      });

      const corpusRpc = supabase.rpc as unknown as (
        fn: "search_legal_corpus_dual",
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;

      const chunkPromise = corpusRpc("search_legal_corpus_dual", {
        p_query_text: query,
        p_metric_embedding: null,
        p_qwen_embedding: null,
        p_content_domain: "practice",
        p_norm_status: "active",
        p_limit: 50,
        p_metric_limit: 0,
        p_qwen_limit: 0,
        p_bm25_limit: 50,
        p_effective_at: null,
      }).then(
        (res) => res,
        () => ({ data: null, error: { message: "chunk search unavailable" } })
      );

      const [edgeResult, chunkResult] = await Promise.all([edgePromise, chunkPromise]);

      // Edge function may fail (timeout, etc.) — treat as soft failure
      const edgeDocs: KBDocument[] = edgeResult.error ? [] : (edgeResult.data?.documents || []);

      // Merge chunk-RPC results (if any) with edge results
      const seenIds = new Set(edgeDocs.map((d) => d.id));
      if (chunkResult.data && Array.isArray(chunkResult.data)) {
        for (const row of chunkResult.data) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);

          edgeDocs.push({
            id: row.document_id,
            title: row.title || row.doc_id || "Untitled",
            practice_category: (row.source === "echr" ? "echr" : category || "civil") as PracticeCategory,
            court_type: (row.source || "first_instance") as CourtType,
            outcome: "partial" as Outcome,
            applied_articles: [],
            key_violations: [],
            legal_reasoning_summary: row.text_snippet || null,
            decision_map: (row.decision_map as DecisionMap) || null,
            key_paragraphs: Array.isArray(row.key_paragraphs) ? (row.key_paragraphs as unknown as KeyParagraph[]) : [],
            top_chunks: [],
            totalChunks: 0,
            max_score: Number(row.score ?? 0) || 0,
          });
        }
      }

      // Limit to top 20 merged results
      const documents = edgeDocs.slice(0, 20);

      setState((s) => ({
        ...s,
        documents,
        isSearching: false,
        searchError: null,
      }));

      return documents;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed";
      setState((s) => ({
        ...s,
        documents: [],
        isSearching: false,
        searchError: message,
      }));
      return [];
    }
  }, []);

  /**
   * Load a specific chunk by docId and chunkIndex
   */
  const loadChunk = useCallback(async (
    docId: string,
    chunkIndex: number
  ): Promise<KBChunk | null> => {
    const key = `${docId}:${chunkIndex}`;

    // Check cache first
    if (state.loadedChunks.has(key)) {
      return state.loadedChunks.get(key)!;
    }

    setState((s) => ({ ...s, isLoadingChunk: true, chunkError: null }));

    void docId;
    void chunkIndex;
    const message = "Full chunk loading is unavailable until a live unified-corpus chunk lookup RPC is verified.";
    setState((s) => ({
      ...s,
      isLoadingChunk: false,
      chunkError: message,
    }));
    return null;
  }, [state.loadedChunks]);

  /**
   * Get a cached chunk without network call
   */
  const getCachedChunk = useCallback((docId: string, chunkIndex: number): KBChunk | null => {
    return state.loadedChunks.get(`${docId}:${chunkIndex}`) || null;
  }, [state.loadedChunks]);

  /**
   * Clear all state
   */
  const clearSearch = useCallback(() => {
    setState({
      documents: [],
      isSearching: false,
      searchError: null,
      loadedChunks: new Map(),
      isLoadingChunk: false,
      chunkError: null,
    });
  }, []);

  /** Directly set documents from an external source (e.g. unified search) */
  const setDocuments = useCallback((docs: KBDocument[]) => {
    setState((s) => ({ ...s, documents: docs, isSearching: false, searchError: null }));
  }, []);

  return {
    // State
    documents: state.documents,
    isSearching: state.isSearching,
    searchError: state.searchError,
    loadedChunks: state.loadedChunks,
    isLoadingChunk: state.isLoadingChunk,
    chunkError: state.chunkError,

    // Actions
    searchKB,
    loadChunk,
    getCachedChunk,
    clearSearch,
    setDocuments,
  };
}

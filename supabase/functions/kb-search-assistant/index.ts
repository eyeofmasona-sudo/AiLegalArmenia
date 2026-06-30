import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";
// model-config import removed — all AI calls routed via openai-router.ts (callText)
import { handleCors } from "../_shared/edge-security.ts";
import { recordAiMetric } from "../_shared/ai-metrics.ts";

interface KBSearchResult {
  id: string;
  title: string;
  content_text: string;
  category: string;
  source_name?: string | null;
  source_url?: string | null;
  rank: number;
}

interface SearchOutput {
  results: Array<{
    title: string;
    snippet: string;
    source: string;
    category: string;
    documentId: string;
  }>;
  keywords: string[];
  totalFound: number;
  retrieval_mode: "keyword_only";
  semantic_ok: false;
  semantic_error: string;
  qwen_semantic_ok: false;
  qwen_semantic_error: string;
  threshold_applied: false;
}

interface CorpusRow {
  document_id: string;
  doc_id: string | null;
  title: string | null;
  text_snippet: string | null;
  source_url: string | null;
  source: string | null;
  score: number;
}

const SEARCH_ASSISTANT_SYSTEM_PROMPT = `
Extract the most important Armenian, Russian, or English legal search keywords from the user query.
Return only a JSON array of strings. Do not include prose.
`.trim();

serve(async (req) => {
  const cors = handleCors(req);
  if (cors.errorResponse) return cors.errorResponse;
  const corsHeaders = cors.corsHeaders!;

  try {
    // === AUTH GUARD ===
    const authHeader = req.headers.get("Authorization") ?? "";
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await sb.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // === END AUTH GUARD ===

    const { query, limit = 20 } = await req.json();

    if (!query || typeof query !== "string") {
      return new Response(
        JSON.stringify({ error: "Query is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`KB Search Assistant: query="${query.substring(0, 100)}..."`);

    // Step 1: Use AI to extract keywords from the query
    let keywords: string[] = [];
    
    try {
      // Route via centralized OpenAI router
      const { callText } = await import("../_shared/openai-router.ts");
      const kbResult = await callText("kb-search-assistant", [
        { role: "system", content: SEARCH_ASSISTANT_SYSTEM_PROMPT },
        { role: "user", content: query },
      ]);
      const aiResponse = { ok: true, json: async () => ({ choices: [{ message: { content: kbResult.text } }] }) };

      if (aiResponse.ok) {
        const aiData = await aiResponse.json();
        const content = aiData.choices?.[0]?.message?.content || "";
        
        // Parse the JSON array from the response
        const jsonMatch = content.match(/\[.*\]/s);
        if (jsonMatch) {
          try {
            keywords = JSON.parse(jsonMatch[0]);
            console.log(`AI extracted keywords: ${keywords.join(", ")}`);
          } catch {
            console.log("Failed to parse AI keywords, using fallback");
          }
        }
      }
    } catch (aiErr) {
      console.error("AI keyword extraction error:", aiErr);
    }

    // Fallback: extract keywords manually if AI failed
    if (keywords.length === 0) {
      keywords = query
        .split(/[\s,.\u054D\u057F]+/)
        .filter((w: string) => w.length > 2 && !/^[0-9]+$/.test(w))
        .slice(0, 10);
      console.log(`Fallback keywords: ${keywords.join(", ")}`);
    }

    // Step 2: Search the unified corpus with extracted keywords
    let searchResults: KBSearchResult[] = [];
    
    if (keywords.length > 0) {
      const { data, error } = await supabase.rpc("search_legal_corpus_dual", {
        p_query_text: keywords.join(" "),
        p_metric_embedding: null,
        p_qwen_embedding: null,
        p_content_domain: "knowledge_base",
        p_norm_status: "active",
        p_limit: Math.min(limit, 50),
        p_metric_limit: 0,
        p_qwen_limit: 0,
        p_bm25_limit: Math.min(Math.max(limit, 20), 50),
        p_effective_at: null,
      });

      if (!error && data) {
        searchResults = ((Array.isArray(data) ? data : []) as CorpusRow[])
          .map((r) => ({
            id: r.document_id,
            title: r.title || r.doc_id || "Untitled",
            content_text: r.text_snippet || "",
            category: r.source || "knowledge_base",
            source_name: r.source,
            source_url: r.source_url,
            rank: Number(r.score) || 0,
          }))
          .sort((a, b) => b.rank - a.rank);
      }
    }

    // Fallback: use the raw query if keyword extraction produced no corpus hits
    if (searchResults.length === 0) {
      const { data: ftsData, error: ftsError } = await supabase.rpc("search_legal_corpus_dual", {
        p_query_text: query,
        p_metric_embedding: null,
        p_qwen_embedding: null,
        p_content_domain: "knowledge_base",
        p_norm_status: "active",
        p_limit: limit,
        p_metric_limit: 0,
        p_qwen_limit: 0,
        p_bm25_limit: Math.max(limit, 20),
        p_effective_at: null,
      });

      if (!ftsError && ftsData) {
        searchResults = ((Array.isArray(ftsData) ? ftsData : []) as CorpusRow[])
          .map((r) => ({
            id: r.document_id,
            title: r.title || r.doc_id || "Untitled",
            content_text: r.text_snippet || "",
            category: r.source || "knowledge_base",
            source_name: r.source,
            source_url: r.source_url,
            rank: Number(r.score) || 0,
          }))
          .filter((r) => r.rank > 0.001);
      }
    }

    // Step 3: Format output according to requirements
    const output: SearchOutput = {
      results: searchResults.slice(0, limit).map((r) => ({
        title: r.title,
        snippet: r.content_text.substring(0, 300) + (r.content_text.length > 300 ? "..." : ""),
        source: r.source_name || r.source_url || `ID: ${r.id}`,
        category: r.category,
        documentId: r.id,
      })),
      keywords,
      totalFound: searchResults.length,
      retrieval_mode: "keyword_only",
      semantic_ok: false,
      semantic_error: "SEMANTIC_EMBEDDING_NOT_REQUESTED",
      qwen_semantic_ok: false,
      qwen_semantic_error: "QWEN_QUERY_EMBEDDING_UNAVAILABLE",
      threshold_applied: false,
    };

    // Log API usage
    try {
      const { getModelConfig: _getModelConfig } = await import("../_shared/openai-router.ts");
      const kbCfg = _getModelConfig("kb-search-assistant");
      await recordAiMetric(supabase, {
        fnName: "kb-search-assistant",
        model: kbCfg.model,
        costUsd: 0.0005,
        status: "success",
      });
    } catch (logErr) {
      console.error("Failed to log AI metric:", logErr);
    }

    console.log(`KB Search completed: ${output.results.length} results found`);

    return new Response(
      JSON.stringify(output),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("KB Search Assistant error:", error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : "Unknown error",
        results: [],
        keywords: [],
        totalFound: 0
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

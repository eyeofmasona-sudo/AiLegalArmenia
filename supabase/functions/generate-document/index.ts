import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log, err } from "../_shared/safe-logger.ts";
import { sandboxUserInput, secureSandbox, logInjectionAttempt, ANTI_INJECTION_RULES } from "../_shared/prompt-armor.ts";
import { applyBudgets, logTokenUsage, type RankedContent } from "../_shared/token-budget.ts";
// model-config import removed — all AI calls routed via openai-router.ts (callText)
import { DOCUMENT_PROMPTS } from "./prompts/index.ts";
import { SYSTEM_PROMPTS } from "./system-prompts.ts";
import {
  validateRequest,
  buildRecipientInfo,
  buildSenderInfo,
  buildContextText,
  getLanguageNote,
} from "./validators.ts";
import { 
  composePrompt, 
  getJurisdictionFromCategory,
  validateComposedPrompt 
} from "./prompt-composer.ts";
import { getRolePrompt, ROLE_CONFIGS, LegalRole } from "./prompts/role-prompts.ts";
import { dualSearch } from "../_shared/rag-search.ts";
import { buildSearchQuery, mapCategoryToPracticeCategory } from "./rag-search.ts";
import { parseReferencesText, buildUserSourcesBlock } from "../_shared/reference-sources.ts";
import { verifyCitationsInText, type CitationValidation } from "../_shared/citation-verifier.ts";
import { buildLegalCorePrompt, LEGAL_CORE_RESPONSE_HEADER } from "../_shared/legal-core-prompt.ts";
import { buildLegalReasoningContext, buildReasoningSearchQuery, runLegalReasoningEngine } from "../_shared/legal-reasoning-engine.ts";
import { buildTemporalContextForPrompt } from "../_shared/temporal-validity-engine.ts";
import { runOfficialSourceFactCheckStub } from "../_shared/official-source-fact-checker.ts";
import { isQABlocked, QA_BLOCK_MESSAGE_HY, type FinalLegalQALike } from "../_shared/qa-block-guard.ts";
// Phase 8.1: converted from dynamic import for reliable Supabase bundler detection.
import { checkRateLimits } from "../_shared/rate-limiter.ts";
import { runLegalPipeline } from "../_shared/legal-pipeline-orchestrator.ts";
import { callText } from "../_shared/openai-router.ts";
import { runFinalLegalQA as runFinalLegalQAFn } from "../_shared/final-legal-qa-agent.ts";

// =============================================================================
// CORS HEADERS (wildcard for browser compatibility)
// =============================================================================
import { handleCors } from "../_shared/edge-security.ts";

serve(async (req) => {
  // === CORS via centralized handler ===
  const corsResult = handleCors(req);
  if (corsResult.errorResponse) return corsResult.errorResponse;
  const corsHeaders = corsResult.corsHeaders!;

  try {
    // === AUTH GUARD (Audit Fix: Stage 2/5 — Critical) ===
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // === END AUTH GUARD ===

    // === RATE LIMITING (P0) — before any body parsing or DB lookups ===
    const supabaseServiceUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseServiceUrl, supabaseServiceRoleKey);
    const rateCheck = await checkRateLimits(serviceClient, user.id, "generate-document");
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: rateCheck.reason, message: rateCheck.message, retry_after_seconds: rateCheck.reason === "hourly_limit_exceeded" ? 3600 : undefined }),
        { status: rateCheck.status || 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // === END RATE LIMITING ===

    const body = await req.json();
    const request = validateRequest(body);
    const referencesText: string = typeof body.referencesText === "string" ? body.referencesText : "";

    // === FIX 1 (P0): Resolve referenceDate for temporal RAG ===
    let referenceDate: string | null = null;
    const rawCaseDate = typeof body.caseDate === "string" ? body.caseDate.trim() : "";
    if (rawCaseDate && /^\d{4}-\d{2}-\d{2}/.test(rawCaseDate)) {
      referenceDate = rawCaseDate.substring(0, 10); // normalize to YYYY-MM-DD
    } else if (request.caseData?.court) {
      // Attempt to fetch court_date from case if caseData has a case reference
      // (caseData itself doesn't carry court_date, so we skip DB lookup here)
    }
    // body.caseId fallback: fetch court_date from cases table
    const bodyCaseId = typeof body.caseId === "string" ? body.caseId : null;
    if (!referenceDate && bodyCaseId) {
      const { data: dateRow } = await authClient
        .from("cases")
        .select("court_date")
        .eq("id", bodyCaseId)
        .maybeSingle();
      if (dateRow?.court_date) {
        referenceDate = String(dateRow.court_date).substring(0, 10);
      }
    }
    if (!referenceDate) {
      // Fallback to today's date for temporal RAG — documents without a case context
      // still need a reference date to retrieve currently-active legislation.
      referenceDate = new Date().toISOString().substring(0, 10);
      log("generate-document", "No caseDate/caseId provided, using today as referenceDate", { referenceDate });
    }
    log("generate-document", "Resolved referenceDate", { referenceDate });

    // Parse user-selected sources (optional)
    let userSourcesBlock = "";
    if (referencesText.trim()) {
      const { refs } = parseReferencesText(referencesText);
      const capped = refs.slice(0, 10);
      userSourcesBlock = buildUserSourcesBlock(capped);
      if (refs.length > 10) {
        userSourcesBlock += "\nNOTE: Only first 10 of " + refs.length + " user-selected sources included due to token budget.\n";
      }
      log("generate-document", "User sources parsed", { count: capped.length, total: refs.length });
    }

    // Build context from case data and/or source text
    const contextText = buildContextText(request);
    const recipientInfo = buildRecipientInfo(request);
    const senderInfo = buildSenderInfo(request);
    // Import orchestrator

    let kbContext = "";
    let legalPracticeContext = "";
    // Cache RAG result so the post-LLM QA pipeline reuses it without a second DB call.
    let cachedRagResult: unknown = null;

    const deps: any = {
      runRAG: async (query: any, opts: any) => {
        const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
        const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { kbResults: [], practiceResults: [], semantic_ok: false };

        const searchTerms = buildSearchQuery(request.category, request.templateName);
        const practiceCategory = mapCategoryToPracticeCategory(request.category);
        
        try {
          const rag = await dualSearch({
            supabase: authClient,
            supabaseUrl: SUPABASE_URL,
            supabaseKey: SUPABASE_SERVICE_KEY,
            query: query || searchTerms.join(' '),
            category: practiceCategory,
            referenceDate: opts.referenceDate,
            kbLimit: 8,
            practiceLimit: 5,
            fullPracticeText: false,
          });
          
          kbContext = rag.kbContext || "";
          legalPracticeContext = rag.practiceContext || "";

          cachedRagResult = {
            kbResults: rag.kbResults || [],
            practiceResults: rag.practiceResults || [],
            semantic_ok: true,
          };
          return cachedRagResult;
        } catch (e) {
          err("generate-document", "RAG error", e);
          cachedRagResult = { kbResults: [], practiceResults: [], semantic_ok: false };
          return cachedRagResult;
        }
      }
    };

    const pipelineResult = await runLegalPipeline({
      mode: "document",
      userQuery: `${request.templateName} ${request.category} ${request.subcategory || ""}`,
      caseText: contextText,
      documentText: typeof request.sourceText === "string" ? request.sourceText : "",
      caseType: request.category,
      language: request.language || "hy",
      effectiveAt: referenceDate,
      functionContext: "generate-document",
    }, deps);

    const legalReasoning = pipelineResult.reasoning!;
    const legalReasoningContext = pipelineResult.legalReasoningContext;

    if (kbContext || legalPracticeContext) {
      // Apply token budgets to RAG contexts
      const budgeted = applyBudgets({
        userFacts: contextText,
        ragLegislation: kbContext ? [{ text: kbContext, score: 10 }] : [],
        ragPractice: legalPracticeContext ? [{ text: legalPracticeContext, score: 10 }] : [],
      }, "document");
      logTokenUsage("generate-document", user.id, budgeted.usage);
      kbContext = budgeted.ragLegislation;
      legalPracticeContext = budgeted.ragPractice;
      
      log("generate-document", "RAG context", { kbLen: kbContext.length, practiceLen: legalPracticeContext.length });
    }

    // Select the most specific prompt available
    const documentPrompt = DOCUMENT_PROMPTS[request.templateId || ''] 
      || DOCUMENT_PROMPTS[request.subcategory || ''] 
      || DOCUMENT_PROMPTS[request.category] 
      || DOCUMENT_PROMPTS.general;

    // Get language-specific system prompt
    const language = request.language || 'hy';
    const languageNote = getLanguageNote(language);
    
    // Determine jurisdiction from category
    const jurisdiction = getJurisdictionFromCategory(request.category);

    // Build user context for prompt composition
    const userContextBlock = `DOCUMENT TO GENERATE: "${request.templateName}"
CATEGORY: ${request.category}${request.subcategory ? ` / ${request.subcategory}` : ''}

SPECIFIC INSTRUCTIONS FOR THIS DOCUMENT TYPE:
${documentPrompt}

RECIPIENT INFORMATION:
${recipientInfo}

APPLICANT/SENDER INFORMATION:
${senderInfo}

CONTEXT AND FACTS:
${secureSandbox("CONTEXT_AND_FACTS", contextText, "generate-document").output}

${request.additionalFields ? `ADDITIONAL INFORMATION:\n${JSON.stringify(request.additionalFields, null, 2)}` : ''}

${kbContext ? `---
RELEVANT LEGAL SOURCES FROM KNOWLEDGE BASE:

${kbContext}
---` : ''}

${legalPracticeContext ? `---
ANALOGOUS COURT PRACTICE (KB REFERENCE ONLY - for legal argumentation structure):

${legalPracticeContext}
---` : ''}

LANGUAGE REQUIREMENT:
${languageNote}

${userSourcesBlock}

${userSourcesBlock ? `If any user-selected source conflicts with the template structure or legal sources above, state the conflict explicitly before proceeding.
When user-selected sources are provided, you MUST cite them by docId and chunkIndex in your document.
` : ''}Generate a complete, professional legal document that is ready for submission to Armenian authorities/courts.
Use the legal sources and court practice above to strengthen legal argumentation where applicable.`;

    // ==========================================================================
    // COMPOSE PROMPT WITH ROLE-AWARENESS (NEW MODULAR ARCHITECTURE)
    // ==========================================================================
    let systemPrompt: string;
    let userPrompt: string;

    if (request.role) {
      // Use new layered prompt composition
      const composed = composePrompt({
        language,
        role: request.role,
        jurisdiction,
        documentPrompt,
        userContext: userContextBlock
      });

      // Validate composed prompt
      if (!validateComposedPrompt(composed)) {
        console.error("Prompt validation errors:", composed.validationErrors);
        return new Response(
          JSON.stringify({ 
            error: "Role validation failed", 
            details: composed.validationErrors 
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      systemPrompt = composed.systemPrompt;
      userPrompt = composed.userPrompt;
      
      log("generate-document", "Role-aware generation", { role: request.role, jurisdiction });
    } else {
      // Legacy mode: use original system prompt without role layer
      systemPrompt = SYSTEM_PROMPTS[language] || SYSTEM_PROMPTS.hy;
      userPrompt = userContextBlock;
    }
    systemPrompt = pipelineResult.legalCorePrompt + "\n\n" + systemPrompt;

    log("generate-document", "Generating", { promptLen: userPrompt.length, sysLen: systemPrompt.length });

    // Route via centralized OpenAI router

    let generatedContent: string;
    let modelUsed: string;
    try {
      const result = await callText("generate-document", [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);
      generatedContent = result.text;
      modelUsed = result.model_used;
      log("generate-document", "Document generated", { len: generatedContent.length, model: modelUsed });
    } catch (routerErr) {
      const status = (routerErr as { status?: number })?.status;
      if (status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits need to be replenished." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      err("generate-document", "AI router error", routerErr);
      throw routerErr;
    }

    // ── Phase 6.9: QA Chain ─────────────────────────────────────────────────
    // Second pipeline call: reuse cached RAG, add all QA deps + generatedText.
    // Stages 1-3 reuse cached RAG (no DB re-fetch), stages 5-8 run QA chain.

    const qaDeps: any = {
      runRAG: async () =>
        cachedRagResult ?? { kbResults: [], practiceResults: [], semantic_ok: false },
      verifyCitations: (text: string, opts: unknown) =>
        verifyCitationsInText(text, serviceClient, {
          ...(opts as Record<string, unknown>),
          skipIds: [bodyCaseId, user.id],
          fn: "generate-document",
          mode: "markers",
          referenceDate,
        }),
      runOfficialFactCheck: (text: string, citations: string[], meta: Record<string, unknown>) =>
        runOfficialSourceFactCheckStub({
          analysisText: text,
          citations,
          metadata: meta,
        }),
      runFinalLegalQA: runFinalLegalQAFn,
    };

    const qaResult = await runLegalPipeline({
      mode: "document",
      userQuery: `${request.templateName} ${request.category} ${request.subcategory || ""}`,
      caseText: contextText,
      documentText: typeof request.sourceText === "string" ? request.sourceText : "",
      caseType: request.category,
      language: request.language || "hy",
      effectiveAt: referenceDate,
      functionContext: "generate-document",
      generatedText: generatedContent,
    }, qaDeps);

    const citationValidation = qaResult.citationVerification as CitationValidation | null;
    log("generate-document", "QA chain complete", {
      citationRisk: citationValidation?.citation_risk_level,
      officialStatus: qaResult.officialSourceFactCheck?.official_fact_check_status,
      finalQAStatus: qaResult.finalLegalQA?.final_legal_qa_status,
    });

    // ── Phase 7.5A: Hard QA Block ────────────────────────────────────────────
    const qaBlocked = isQABlocked(qaResult.finalLegalQA as FinalLegalQALike | null);
    const publicContent = qaBlocked ? QA_BLOCK_MESSAGE_HY : generatedContent;
    if (qaBlocked) {
      log("generate-document", "QA BLOCKED — content withheld from public response", {
        finalQAStatus: (qaResult.finalLegalQA as FinalLegalQALike | null)?.final_legal_qa_status,
        safeToShowUser: (qaResult.finalLegalQA as FinalLegalQALike | null)?.safe_to_show_user,
      });
    }

    return new Response(
      JSON.stringify({
        content: publicContent,
        tokensUsed: 0,
        role: request.role || "default",
        jurisdiction,
        model_used: modelUsed,
        ...LEGAL_CORE_RESPONSE_HEADER,
        temporal_validity_checked: !!referenceDate,
        legal_reasoning: legalReasoning,
        // QA metadata — all from Orchestrator v2 (Phase 6.9)
        validation: citationValidation,
        verified_citations: citationValidation?.verified_citations,
        weak_citations: citationValidation?.weak_citations,
        missing_citations: citationValidation?.missing_citations,
        citation_risk_level: citationValidation?.citation_risk_level,
        official_source_fact_check: qaResult.officialSourceFactCheck,
        final_legal_qa: qaResult.finalLegalQA,
        pipeline_metadata: qaResult.metadata,
        pipeline_warnings: qaResult.pipelineWarnings,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    err("generate-document", "Unhandled error", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

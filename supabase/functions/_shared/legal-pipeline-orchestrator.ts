/**
 * Legal Pipeline Orchestrator — v2.0.0 (PHASE 6.8)
 *
 * Unified QA Chain. New stage sequence:
 *   reasoning → retrieval → enrichment → prompt_build
 *   → citation_verification → official_source_fact_check → final_legal_qa → verification
 *
 * All QA stages are driven by optional deps.
 * No network, no DB, no fetch calls in this module.
 * All external work arrives via dependency injection.
 */

import {
  runLegalReasoningEngine,
  buildReasoningSearchQuery,
  buildLegalReasoningContext,
  type LegalReasoningInput,
  type LegalReasoningOutput,
} from "./legal-reasoning-engine.ts";
import { buildSourceHierarchyContext } from "./source-hierarchy-engine.ts";
import { buildCourtPracticeContext } from "./court-practice-engine.ts";
import { buildTemporalContextForPrompt } from "./temporal-validity-engine.ts";
import { buildLegalCorePrompt } from "./legal-core-prompt.ts";
import type { FinalLegalQAInput, FinalLegalQAResult } from "./final-legal-qa-agent.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LegalPipelineMode =
  | "chat"
  | "analysis"
  | "multi_agent"
  | "document"
  | "complaint";

export type LegalPipelineStageStatus =
  | "pass"
  | "warning"
  | "fail"
  | "skipped";

export interface LegalPipelineInput {
  mode: LegalPipelineMode;
  userQuery?: string;
  caseText?: string;
  documentText?: string;
  caseType?: string;
  language?: string;
  effectiveAt?: string | null;
  functionContext?: string;
  role?: string;
  options?: Record<string, unknown>;
  /** Raw generated text to be verified / QA-checked. */
  generatedText?: string;
}

export interface LegalPipelineStage {
  name: string;
  status: LegalPipelineStageStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  warnings: string[];
  errors: string[];
}

export interface LegalPipelineResult {
  // Core analysis outputs
  reasoning: LegalReasoningOutput | null;
  rag: unknown | null;
  temporal: unknown | null;
  hierarchy: unknown | null;
  courtPractice: unknown | null;
  legalCorePrompt: string;
  legalReasoningContext: string;

  // QA outputs
  /** @deprecated Use citationVerification — kept for backward compatibility. */
  verification: unknown | null;
  citationVerification: unknown | null;
  officialSourceFactCheck: { official_fact_check_status: string; [k: string]: unknown } | null;
  finalLegalQA: FinalLegalQAResult | null;

  // Pipeline meta
  stages: LegalPipelineStage[];
  warnings: string[];
  errors: string[];
  /** Warnings from QA stages only (citation_verification, official_source_fact_check, final_legal_qa). */
  pipelineWarnings: string[];
  /** Errors from QA stages only. */
  pipelineErrors: string[];
  metadata: {
    pipeline_version: string;
    pipeline_duration_ms: number;
    mode: LegalPipelineMode;
    cautious_output_required: boolean;
  };
}

// ---------------------------------------------------------------------------
// Dependency Injection surface
// ---------------------------------------------------------------------------

export interface LegalPipelineDeps {
  /** Required: full-text + semantic retrieval. */
  runRAG: (query: string, opts: unknown) => Promise<unknown>;

  /**
   * Optional: citation verification.
   * If absent, `citation_verification` stage is skipped (no error).
   */
  verifyCitations?: (text: string, opts: unknown) => Promise<unknown>;

  /**
   * Optional: official source fact-check.
   * If absent, result.officialSourceFactCheck.official_fact_check_status = "NOT_RUN".
   */
  runOfficialFactCheck?: (
    text: string,
    citations: string[],
    meta: Record<string, unknown>,
  ) => unknown | Promise<unknown>;

  /**
   * Optional: final legal QA gate.
   * If absent, result.finalLegalQA.final_legal_qa_status = "NOT_RUN".
   */
  runFinalLegalQA?: (input: FinalLegalQAInput) => FinalLegalQAResult | Promise<FinalLegalQAResult>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createStage(name: string): LegalPipelineStage {
  return {
    name,
    status: "skipped",
    startedAt: new Date().toISOString(),
    endedAt: "",
    durationMs: 0,
    warnings: [],
    errors: [],
  };
}

function endStage(stage: LegalPipelineStage, status: LegalPipelineStageStatus) {
  stage.endedAt = new Date().toISOString();
  stage.durationMs =
    new Date(stage.endedAt).getTime() - new Date(stage.startedAt).getTime();
  // Never downgrade an already-failed or warned stage
  if (stage.status !== "fail" && stage.status !== "warning") {
    stage.status = status;
  }
}

function _extractCitationsFromVerification(citationVerification: unknown): string[] {
  if (!citationVerification || typeof citationVerification !== "object") return [];
  const cv = citationVerification as Record<string, unknown>;
  const verified = Object.keys((cv.verified_citations as Record<string, unknown>) || {});
  const missing = Array.isArray(cv.missing_ids) ? (cv.missing_ids as string[]) : [];
  return [...verified, ...missing];
}

// ---------------------------------------------------------------------------
// Stage 1: Reasoning
// ---------------------------------------------------------------------------

export async function runReasoningStage(
  input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
) {
  try {
    const reasoningInput: LegalReasoningInput = {
      user_query: input.userQuery,
      case_text: input.caseText,
      uploaded_document_text: input.documentText,
      case_type: input.caseType,
      language: input.language,
      effective_at: input.effectiveAt,
      function_context: input.functionContext || input.mode,
    };

    result.reasoning = runLegalReasoningEngine(reasoningInput);

    if (result.reasoning.risk_flags.length > 0) {
      stage.warnings.push(...result.reasoning.risk_flags);
    }

    endStage(stage, stage.warnings.length > 0 ? "warning" : "pass");
  } catch (error: unknown) {
    stage.errors.push((error as Error).message || String(error));
    endStage(stage, "fail");
  }
}

// ---------------------------------------------------------------------------
// Stage 2: Retrieval
// ---------------------------------------------------------------------------

export async function runRetrievalStage(
  input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
  deps: LegalPipelineDeps,
) {
  if (!result.reasoning) {
    stage.errors.push("Reasoning stage must run before retrieval stage");
    endStage(stage, "fail");
    return;
  }

  try {
    const query = buildReasoningSearchQuery(result.reasoning, input.userQuery || "");
    const ragOpts = { referenceDate: input.effectiveAt, ...input.options };

    result.rag = await deps.runRAG(query, ragOpts);

    const rag = result.rag as Record<string, unknown>;
    if (rag?.semantic_ok === false) {
      stage.warnings.push("RAG Semantic Search Failed, fallback used");
      result.metadata.cautious_output_required = true;
    }

    endStage(stage, stage.warnings.length > 0 ? "warning" : "pass");
  } catch (error: unknown) {
    stage.errors.push((error as Error).message || String(error));
    result.metadata.cautious_output_required = true;
    endStage(stage, "fail");
  }
}

// ---------------------------------------------------------------------------
// Stage 3: Enrichment
// ---------------------------------------------------------------------------

export async function runEnrichmentStage(
  input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
) {
  if (!result.reasoning) {
    stage.errors.push("Reasoning stage must run before enrichment");
    endStage(stage, "fail");
    return;
  }

  try {
    const rag = result.rag as Record<string, unknown>;
    const kbResults = Array.isArray(rag?.kbResults) ? rag.kbResults : [];
    const practiceResults = Array.isArray(rag?.practiceResults) ? rag.practiceResults : [];
    const allResults = [...(kbResults as unknown[]), ...(practiceResults as unknown[])];

    if (!input.effectiveAt) {
      stage.warnings.push("missing_effective_at");
      result.warnings.push("missing_effective_at");
    }

    result.hierarchy = buildSourceHierarchyContext(allResults as never, result.reasoning);
    result.courtPractice = buildCourtPracticeContext(
      practiceResults as never,
      result.reasoning,
    );

    // Assign back to reasoning (current endpoints depend on this)
    result.reasoning.source_hierarchy = result.hierarchy as never;
    result.reasoning.court_practice = result.courtPractice as never;
    result.reasoning.temporal_validation = buildTemporalContextForPrompt(
      result.reasoning,
      allResults as never,
    );
    result.temporal = result.reasoning.temporal_validation;

    const hierarchy = result.hierarchy as Record<string, unknown>;
    if (Array.isArray(hierarchy?.conflicts) && (hierarchy.conflicts as unknown[]).length > 0) {
      result.reasoning.risk_flags.push("source_conflict_warning");
      result.metadata.cautious_output_required = true;
      stage.warnings.push("Source conflicts detected");
    }

    result.legalReasoningContext = buildLegalReasoningContext(result.reasoning);
    endStage(stage, stage.warnings.length > 0 ? "warning" : "pass");
  } catch (error: unknown) {
    stage.errors.push((error as Error).message || String(error));
    endStage(stage, "fail");
  }
}

// ---------------------------------------------------------------------------
// Stage 4: Prompt Build
// ---------------------------------------------------------------------------

export async function runPromptBuildStage(
  input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
) {
  if (!result.stages.find((s) => s.name === "enrichment")) {
    stage.errors.push("Enrichment stage must run before prompt build");
    endStage(stage, "fail");
    return;
  }

  try {
    const { buildCuratedLegalReasoningContext } = await import(
      "./legal-reasoning-engine.ts"
    );
    const curatedContext = result.reasoning
      ? buildCuratedLegalReasoningContext(result.reasoning)
      : "";

    result.legalCorePrompt = buildLegalCorePrompt({
      functionName: input.functionContext || input.mode,
      role: input.role || input.mode,
      temporalValidityChecked: !!input.effectiveAt,
      legalReasoningContext: curatedContext,
    });
    endStage(stage, "pass");
  } catch (error: unknown) {
    stage.errors.push((error as Error).message || String(error));
    endStage(stage, "fail");
  }
}

// ---------------------------------------------------------------------------
// Stage 5: Citation Verification
// (was "verification" in v1; renamed for QA chain clarity)
// ---------------------------------------------------------------------------

export async function runCitationVerificationStage(
  input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
  deps: LegalPipelineDeps,
) {
  if (!input.generatedText) {
    stage.warnings.push("No generated text provided for citation verification");
    endStage(stage, "skipped");
    return;
  }

  // Stage 4 (spec): if verifyCitations absent => skipped, no errors
  if (!deps.verifyCitations) {
    endStage(stage, "skipped");
    return;
  }

  try {
    const citationResult = await deps.verifyCitations(input.generatedText, {
      referenceDate: input.effectiveAt,
      ...input.options,
    });
    result.citationVerification = citationResult;
    result.verification = citationResult; // backward-compat alias
    endStage(stage, "pass");
  } catch (error: unknown) {
    stage.errors.push((error as Error).message || String(error));
    endStage(stage, "fail");
  }
}

// ---------------------------------------------------------------------------
// Stage 6: Official Source Fact-Check
// ---------------------------------------------------------------------------

export async function runOfficialFactCheckStage(
  input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
  deps: LegalPipelineDeps,
) {
  // Stage 5 (spec): if dep absent => NOT_RUN, no blocking
  if (!deps.runOfficialFactCheck) {
    result.officialSourceFactCheck = { official_fact_check_status: "NOT_RUN" };
    endStage(stage, "skipped");
    return;
  }

  if (!input.generatedText) {
    result.officialSourceFactCheck = { official_fact_check_status: "NOT_RUN" };
    endStage(stage, "skipped");
    return;
  }

  try {
    const citations = _extractCitationsFromVerification(result.citationVerification);
    const factResult = await Promise.resolve(
      deps.runOfficialFactCheck(input.generatedText, citations, {
        mode: input.mode,
        agentType: input.functionContext,
      }),
    );
    result.officialSourceFactCheck = factResult as {
      official_fact_check_status: string;
      [k: string]: unknown;
    };

    const factStatus = result.officialSourceFactCheck?.official_fact_check_status;
    if (factStatus === "FAIL") {
      stage.warnings.push("Official source fact check FAILED");
      result.metadata.cautious_output_required = true;
      endStage(stage, "warning");
    } else {
      endStage(stage, "pass");
    }
  } catch (error: unknown) {
    stage.errors.push((error as Error).message || String(error));
    endStage(stage, "fail");
  }
}

// ---------------------------------------------------------------------------
// Stage 7: Final Legal QA
// ---------------------------------------------------------------------------

export async function runFinalLegalQAStage(
  input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
  deps: LegalPipelineDeps,
) {
  // Stage 6 (spec): if dep absent => NOT_RUN
  if (!deps.runFinalLegalQA) {
    result.finalLegalQA = {
      final_legal_qa_status: "NOT_RUN",
      confidence: "low",
      blocking_issues: [],
      warnings: ["final_legal_qa_dependency_missing"],
      requires_human_review: false,
      safe_to_show_user: true,
      qa_summary: "Final legal QA was not run.",
      checked_at: new Date().toISOString(),
    };
    endStage(stage, "skipped");
    return;
  }

  try {
    const groundingOk = !result.stages
      .filter((s) => ["reasoning", "retrieval", "enrichment"].includes(s.name))
      .some((s) => s.status === "fail");

    const temporal = result.temporal as Record<string, unknown> | null;
    const temporalValidations = Array.isArray(temporal?.validated_sources)
      ? (temporal!.validated_sources as unknown[])
      : null;

    const qaInput: FinalLegalQAInput = {
      generatedText: input.generatedText || "",
      agentType: input.functionContext || input.mode,
      mode: input.mode,
      citationValidation: result.citationVerification as never,
      officialSourceFactCheck: result.officialSourceFactCheck as never,
      sourceHierarchy: result.hierarchy as never,
      temporalValidations: temporalValidations as never,
      courtPractice: result.courtPractice as never,
      groundingOk,
      groundingStopCode: null,
      legalReasoningRiskFlags: result.reasoning?.risk_flags ?? null,
    };

    result.finalLegalQA = await Promise.resolve(deps.runFinalLegalQA(qaInput));

    const qaStatus = result.finalLegalQA?.final_legal_qa_status;
    if (qaStatus === "FAIL") {
      stage.warnings.push("Final legal QA FAILED — output requires review before use");
      result.metadata.cautious_output_required = true;
      endStage(stage, "warning");
    } else if (qaStatus === "REQUIRES_HUMAN_REVIEW") {
      stage.warnings.push("Final legal QA requires human review");
      result.metadata.cautious_output_required = true;
      endStage(stage, "warning");
    } else {
      endStage(stage, "pass");
    }
  } catch (error: unknown) {
    stage.errors.push((error as Error).message || String(error));
    endStage(stage, "fail");
  }
}

// ---------------------------------------------------------------------------
// Stage 8: Verification Summary
// Aggregates QA stage results into a final pipeline-level verdict.
// ---------------------------------------------------------------------------

export function runVerificationSummaryStage(
  _input: LegalPipelineInput,
  result: LegalPipelineResult,
  stage: LegalPipelineStage,
) {
  const qaStatus = result.finalLegalQA?.final_legal_qa_status;

  if (qaStatus === "FAIL") {
    stage.warnings.push(
      "Pipeline QA failed — output contains blocking issues, human review required",
    );
    result.metadata.cautious_output_required = true;
    endStage(stage, "warning");
  } else if (qaStatus === "REQUIRES_HUMAN_REVIEW") {
    stage.warnings.push("Pipeline QA: human review is required before relying on output");
    result.metadata.cautious_output_required = true;
    endStage(stage, "warning");
  } else {
    endStage(stage, "pass");
  }
}

// ---------------------------------------------------------------------------
// Orchestrator entry point
// ---------------------------------------------------------------------------

export async function runLegalPipeline(
  input: LegalPipelineInput,
  deps: LegalPipelineDeps,
): Promise<LegalPipelineResult> {
  const startTime = Date.now();

  const result: LegalPipelineResult = {
    reasoning: null,
    rag: null,
    temporal: null,
    hierarchy: null,
    courtPractice: null,
    legalCorePrompt: "",
    legalReasoningContext: "",
    verification: null,
    citationVerification: null,
    officialSourceFactCheck: null,
    finalLegalQA: null,
    stages: [],
    warnings: [],
    errors: [],
    pipelineWarnings: [],
    pipelineErrors: [],
    metadata: {
      pipeline_version: "2.0.0",
      pipeline_duration_ms: 0,
      mode: input.mode,
      cautious_output_required: false,
    },
  };

  const reasoningStage = createStage("reasoning");
  result.stages.push(reasoningStage);
  await runReasoningStage(input, result, reasoningStage);

  const retrievalStage = createStage("retrieval");
  result.stages.push(retrievalStage);
  if (reasoningStage.status !== "fail") {
    await runRetrievalStage(input, result, retrievalStage, deps);
  } else {
    endStage(retrievalStage, "skipped");
  }

  const enrichmentStage = createStage("enrichment");
  result.stages.push(enrichmentStage);
  if (retrievalStage.status !== "fail") {
    await runEnrichmentStage(input, result, enrichmentStage);
  } else {
    endStage(enrichmentStage, "skipped");
  }

  const promptBuildStage = createStage("prompt_build");
  result.stages.push(promptBuildStage);
  await runPromptBuildStage(input, result, promptBuildStage);

  const citationVerificationStage = createStage("citation_verification");
  result.stages.push(citationVerificationStage);
  await runCitationVerificationStage(input, result, citationVerificationStage, deps);

  const officialFactCheckStage = createStage("official_source_fact_check");
  result.stages.push(officialFactCheckStage);
  await runOfficialFactCheckStage(input, result, officialFactCheckStage, deps);

  const finalLegalQAStage = createStage("final_legal_qa");
  result.stages.push(finalLegalQAStage);
  await runFinalLegalQAStage(input, result, finalLegalQAStage, deps);

  const verificationStage = createStage("verification");
  result.stages.push(verificationStage);
  runVerificationSummaryStage(input, result, verificationStage);

  result.stages.forEach((s) => {
    result.errors.push(...s.errors);
    result.warnings.push(...s.warnings);
  });

  const qaStageNames = new Set([
    "citation_verification",
    "official_source_fact_check",
    "final_legal_qa",
  ]);
  result.stages
    .filter((s) =
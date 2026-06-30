/**
 * Phase 6.10 — ai-analyze QA Chain Integration Tests
 *
 * These tests validate the endpoint integration pattern without calling DB,
 * RAG, network, or LLM. Runtime behavior is exercised through the shared
 * orchestrator with pure mocks; endpoint wiring is checked statically.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  runLegalPipeline,
  type LegalPipelineDeps,
  type LegalPipelineInput,
} from "../_shared/legal-pipeline-orchestrator.ts";
import { runFinalLegalQA } from "../_shared/final-legal-qa-agent.ts";
import { runOfficialSourceFactCheckStub } from "../_shared/official-source-fact-checker.ts";
import { PROMPT_REGISTRY } from "./prompts/index.ts";

const GENERATED_TEXT = "Analysis cites [ID: 11111111-1111-4111-8111-111111111111].";

const baseInput = (overrides: Partial<LegalPipelineInput> = {}): LegalPipelineInput => ({
  mode: "analysis",
  userQuery: "civil dispute",
  caseText: "The parties dispute performance of a contract.",
  caseType: "advocate",
  language: "auto",
  effectiveAt: "2026-06-30",
  functionContext: "ai-analyze:advocate",
  ...overrides,
});

const fullQaDeps = (): LegalPipelineDeps => ({
  runRAG: async () => ({
    preciseSources: [{ id: "anchor-1", title: "Civil Code article" }],
    sourcesUsed: [{ id: "kb-1", title: "Civil Code" }],
    practiceForCourt: [],
    semantic_ok: true,
  }),
  verifyCitations: async () => ({
    citations_verified: true,
    verified_citations: {
      "11111111-1111-4111-8111-111111111111": {
        document_id: "11111111-1111-4111-8111-111111111111",
      },
    },
    weak_citations: [],
    missing_citations: [],
    missing_ids: [],
    citation_risk_level: "none",
  }),
  runOfficialFactCheck: (text, citations, metadata) =>
    runOfficialSourceFactCheckStub({
      analysisText: text,
      citations,
      metadata,
    }),
  runFinalLegalQA,
});

Deno.test("ai-analyze QA - receives QA metadata from Orchestrator", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  assert(result.citationVerification !== null);
  assert(result.officialSourceFactCheck !== null);
  assert(result.finalLegalQA !== null);
  assertEquals(result.verification, result.citationVerification);
  assertEquals(result.metadata.pipeline_version, "2.0.0");
  assert(Array.isArray(result.pipelineWarnings));
  assert(Array.isArray(result.pipelineErrors));
});

Deno.test("ai-analyze QA - stages run after generatedText is supplied", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  const stageNames = result.stages.map((stage) => stage.name);
  assertEquals(stageNames, [
    "reasoning",
    "retrieval",
    "enrichment",
    "prompt_build",
    "citation_verification",
    "official_source_fact_check",
    "final_legal_qa",
    "verification",
  ]);
  assertEquals(result.stages.find((s) => s.name === "citation_verification")?.status, "pass");
  assertEquals(result.stages.find((s) => s.name === "official_source_fact_check")?.status, "pass");
  assertEquals(result.stages.find((s) => s.name === "final_legal_qa")?.status, "pass");
});

Deno.test("ai-analyze QA - cached RAG can be reused by second pipeline call", async () => {
  let ragCalls = 0;
  const cachedRagResult = {
    preciseSources: [{ id: "anchor-1" }],
    sourcesUsed: [{ id: "kb-1" }],
    practiceForCourt: [],
    semantic_ok: true,
  };
  const deps: LegalPipelineDeps = {
    ...fullQaDeps(),
    runRAG: async () => {
      ragCalls += 1;
      return cachedRagResult;
    },
  };

  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    deps,
  );

  assertEquals(ragCalls, 1);
  assertEquals(result.rag, cachedRagResult);
});

Deno.test("ai-analyze QA - role prompt registry remains intact", () => {
  assert("defense_analysis" in PROMPT_REGISTRY);
  assert("prosecution_analysis" in PROMPT_REGISTRY);
  assert("judge_analysis" in PROMPT_REGISTRY);
  assert("aggregator" in PROMPT_REGISTRY);
  assert("fair_trial_and_rights" in PROMPT_REGISTRY);
  assert("charge_qualification" in PROMPT_REGISTRY);
  assert("risk_factors" in PROMPT_REGISTRY === false);
});

Deno.test("ai-analyze QA - endpoint keeps role prompt selection unchanged", async () => {
  const source = await Deno.readTextFile("supabase/functions/ai-analyze/index.ts");

  assertStringIncludes(source, "systemPrompt = PRECEDENT_CITATION_PROMPT;");
  assertStringIncludes(source, "systemPrompt = DEADLINE_RULES_PROMPT;");
  assertStringIncludes(source, "systemPrompt = LEGAL_POSITION_COMPARATOR_PROMPT;");
  assertStringIncludes(source, "systemPrompt = HALLUCINATION_AUDIT_PROMPT;");
  assertStringIncludes(source, "systemPrompt = DRAFT_DETERMINISTIC_PROMPT;");
  assertStringIncludes(source, "systemPrompt = STRATEGY_BUILDER_PROMPT;");
  assertStringIncludes(source, "systemPrompt = EVIDENCE_WEAKNESS_PROMPT;");
  assertStringIncludes(source, "systemPrompt = RISK_FACTORS_PROMPT;");
  assertStringIncludes(source, "systemPrompt = LAW_UPDATE_SUMMARY_PROMPT;");
  assertStringIncludes(source, "systemPrompt = CROSS_EXAM_PROMPT;");
  assertStringIncludes(source, "systemPrompt = CRIMINAL_MODULE_PROMPTS[moduleId];");
  assertStringIncludes(source, "systemPrompt = getFullPrompt(role as AnalysisType);");
  assertStringIncludes(source, "systemPrompt = SYSTEM_PROMPTS[role as keyof typeof SYSTEM_PROMPTS];");
});

Deno.test("ai-analyze QA - Anchor Lookup Phase 1.5 remains wired", async () => {
  const source = await Deno.readTextFile("supabase/functions/ai-analyze/index.ts");

  assertStringIncludes(source, "PHASE 1.5: Extract norm anchors");
  assertStringIncludes(source, "extractNormRefs(fullCaseText)");
  assertStringIncludes(source, "lookupByAnchors({");
  assertStringIncludes(source, "source_type: \"anchor\"");
  assertStringIncludes(source, "mergeAndDeduplicate(anchorSources, sourcesUsed)");
});

Deno.test("ai-analyze QA - response keeps backward-compatible metadata fields", async () => {
  const source = await Deno.readTextFile("supabase/functions/ai-analyze/index.ts");

  assertStringIncludes(source, "validation: citationValidation");
  assertStringIncludes(source, "verified_citations: citationValidation?.verified_citations");
  assertStringIncludes(source, "weak_citations: citationValidation?.weak_citations");
  assertStringIncludes(source, "missing_citations: citationValidation?.missing_citations");
  assertStringIncludes(source, "citation_risk_level: citationValidation?.citation_risk_level");
  assertStringIncludes(source, "official_source_fact_check: qaResult.officialSourceFactCheck");
  assertStringIncludes(source, "final_legal_qa: qaResult.finalLegalQA");
  assertStringIncludes(source, "pipeline_metadata: qaResult.metadata");
  assertStringIncludes(source, "pipeline_warnings: qaResult.pipelineWarnings");
  assertStringIncludes(source, "pipeline_errors: qaResult.pipelineErrors");
});

Deno.test("ai-analyze QA - endpoint runs QA chain after LLM generation", async () => {
  const source = await Deno.readTextFile("supabase/functions/ai-analyze/index.ts");
  const llmCall = source.indexOf("const result = await callText(\"ai-analyze\"");
  const qaMarker = source.indexOf("Phase 6.10: QA Chain");
  const qaPipeline = source.indexOf("const qaResult = await runLegalPipeline", qaMarker);

  assert(llmCall > 0, "LLM call should exist");
  assert(qaMarker > llmCall, "QA marker should appear after LLM call block");
  assert(qaPipeline > qaMarker, "QA pipeline call should appear after QA marker");
});

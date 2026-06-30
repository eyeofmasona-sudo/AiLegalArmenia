/**
 * Phase 6.9 — generate-complaint QA Chain Integration Tests
 *
 * Tests that `runLegalPipeline` with all QA deps (the pattern used in the
 * generate-complaint endpoint) produces the expected metadata fields.
 * No Deno env, no DB, no network — all deps are pure mocks.
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  runLegalPipeline,
  type LegalPipelineInput,
  type LegalPipelineDeps,
} from "../_shared/legal-pipeline-orchestrator.ts";
import { runFinalLegalQA } from "../_shared/final-legal-qa-agent.ts";
import { runOfficialSourceFactCheckStub } from "../_shared/official-source-fact-checker.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const COMPLAINT_TEXT =
  "Ըստ ՀՀ Քաղ. Դատ. Օրենսգ. 127-րդ հոդ. — the respondent violated Art. 347 CC...";

const baseComplaintInput = (
  overrides: Partial<LegalPipelineInput> = {},
): LegalPipelineInput => ({
  mode: "complaint",
  userQuery: "cassation civil housing eviction",
  caseText: "Respondent failed to vacate premises",
  caseType: "civil",
  language: "hy",
  effectiveAt: "2026-06-30",
  functionContext: "generate-complaint",
  ...overrides,
});

const minimalDeps = (): LegalPipelineDeps => ({
  runRAG: async () => ({
    kbResults: [{ id: "kb-002", title: "RA Housing Code" }],
    practiceResults: [],
    semantic_ok: true,
  }),
});

const fullQaDeps = (): LegalPipelineDeps => ({
  runRAG: async () => ({
    kbResults: [{ id: "kb-002", title: "RA Housing Code" }],
    practiceResults: [],
    semantic_ok: true,
  }),
  verifyCitations: async (_text, _opts) => ({
    citations_verified: true,
    verified_citations: [{ document_id: "kb-002", title: "RA Housing Code" }],
    weak_citations: [],
    missing_citations: [],
    citation_risk_level: "none",
    requires_cautious_language: false,
    forbidden_certainty_phrases: [],
  }),
  runOfficialFactCheck: (text, citations, meta) =>
    runOfficialSourceFactCheckStub({
      analysisText: text,
      citations,
      metadata: meta,
    }),
  runFinalLegalQA: runFinalLegalQA,
});

// ---------------------------------------------------------------------------
// Test 1: citationVerification comes from Orchestrator
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - citationVerification comes from Orchestrator", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput({ generatedText: COMPLAINT_TEXT }),
    fullQaDeps(),
  );

  assert(result.citationVerification !== null, "citationVerification should be set");
  assertEquals(
    (result.citationVerification as Record<string, unknown>).citation_risk_level,
    "none",
  );
  assertEquals(result.verification, result.citationVerification);
});

// ---------------------------------------------------------------------------
// Test 2: officialSourceFactCheck uses the shared stub checker
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - officialSourceFactCheck shared stub runs", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput({ generatedText: COMPLAINT_TEXT }),
    fullQaDeps(),
  );

  assert(result.officialSourceFactCheck !== null);
  assertEquals(result.officialSourceFactCheck?.official_fact_check_status, "UNVERIFIED_OFFICIAL_SOURCE");
});

// ---------------------------------------------------------------------------
// Test 3: finalLegalQA reflects unverified official-source caution
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - finalLegalQA returns WARNING for unverified official sources", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput({ generatedText: COMPLAINT_TEXT }),
    fullQaDeps(),
  );

  assert(result.finalLegalQA !== null);
  assertEquals(result.finalLegalQA?.final_legal_qa_status, "WARNING");
});

// ---------------------------------------------------------------------------
// Test 4: verification stages not duplicated — exactly 8 stages
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - no duplicate stages, exactly 8 total", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput({ generatedText: COMPLAINT_TEXT }),
    fullQaDeps(),
  );

  assertEquals(result.stages.length, 8, "Pipeline must have exactly 8 stages");
  const names = result.stages.map((s) => s.name);
  assertEquals(new Set(names).size, 8, "All stage names must be unique");
});

// ---------------------------------------------------------------------------
// Test 5: QA stages skip when no generatedText (pre-LLM call pattern)
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - QA stages skip when no generatedText", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput(), // no generatedText
    minimalDeps(),
  );

  const citStage = result.stages.find((s) => s.name === "citation_verification");
  assertEquals(citStage?.status, "skipped");

  const factStage = result.stages.find((s) => s.name === "official_source_fact_check");
  assertEquals(factStage?.status, "skipped");

  const qaStage = result.stages.find((s) => s.name === "final_legal_qa");
  assertEquals(qaStage?.status, "skipped");

  // Prompt still built
  assert(result.legalCorePrompt.length > 0);
});

// ---------------------------------------------------------------------------
// Test 6: pipeline_version 2.0.0 in complaint QA result
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - pipeline_version is 2.0.0", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput({ generatedText: COMPLAINT_TEXT }),
    fullQaDeps(),
  );

  assertEquals(result.metadata.pipeline_version, "2.0.0");
});

// ---------------------------------------------------------------------------
// Test 7: pipelineWarnings / pipelineErrors available from Orchestrator
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - pipelineWarnings and pipelineErrors are arrays", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput({ generatedText: COMPLAINT_TEXT }),
    fullQaDeps(),
  );

  assert(Array.isArray(result.pipelineWarnings));
  assert(Array.isArray(result.pipelineErrors));
});

// ---------------------------------------------------------------------------
// Test 8: backward compat — all expected response fields present in result
// ---------------------------------------------------------------------------

Deno.test("generate-complaint QA - backward compat fields present in result", async () => {
  const result = await runLegalPipeline(
    baseComplaintInput({ generatedText: COMPLAINT_TEXT }),
    fullQaDeps(),
  );

  assert("citationVerification" in result);
  assert("officialSourceFactCheck" in result);
  assert("finalLegalQA" in result);
  assert("pipelineWarnings" in result);
  assert("pipelineErrors" in result);
  assert("verification" in result);
  // deprecated alias points to same object
  assertEquals(result.verification, result.citationVerification);
  // legal_reasoning still populated
  assert(result.reasoning !== null, "reasoning must be present for complaint mode");
});

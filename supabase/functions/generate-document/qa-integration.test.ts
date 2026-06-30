/**
 * Phase 6.9 — generate-document QA Chain Integration Tests
 *
 * Tests that `runLegalPipeline` with all QA deps (the pattern used in the
 * generate-document endpoint) produces the expected metadata fields.
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

const GENERATED_TEXT = "Pursuant to RA Civil Code Art. 347, we hereby request...";

const baseInput = (overrides: Partial<LegalPipelineInput> = {}): LegalPipelineInput => ({
  mode: "document",
  userQuery: "Lease termination agreement civil",
  caseText: "Party A and Party B entered lease agreement on 2025-01-01",
  caseType: "civil",
  language: "hy",
  effectiveAt: "2026-06-30",
  functionContext: "generate-document",
  ...overrides,
});

/** Minimal deps that skip all QA (no generatedText, no QA deps). */
const minimalDeps = (): LegalPipelineDeps => ({
  runRAG: async () => ({
    kbResults: [{ id: "kb-001", title: "Civil Code Art 347" }],
    practiceResults: [],
    semantic_ok: true,
  }),
});

/** Full QA deps — mirrors generate-document endpoint after LLM. */
const fullQaDeps = (): LegalPipelineDeps => ({
  runRAG: async () => ({
    kbResults: [{ id: "kb-001", title: "Civil Code Art 347" }],
    practiceResults: [],
    semantic_ok: true,
  }),
  verifyCitations: async (_text, _opts) => ({
    citations_verified: true,
    verified_citations: [{ document_id: "kb-001", title: "Civil Code Art 347" }],
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
// Test 1: QA metadata comes from Orchestrator, not local call
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - citationVerification comes from Orchestrator", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  // citationVerification populated by orchestrator Stage 5
  assert(result.citationVerification !== null, "citationVerification should be non-null");
  assertEquals(
    (result.citationVerification as Record<string, unknown>).citation_risk_level,
    "none",
  );
  // backward-compat alias must also be set
  assertEquals(result.verification, result.citationVerification);
});

// ---------------------------------------------------------------------------
// Test 2: officialSourceFactCheck uses the shared stub checker
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - officialSourceFactCheck shared stub runs", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  assert(result.officialSourceFactCheck !== null, "officialSourceFactCheck should be set");
  assertEquals(
    result.officialSourceFactCheck?.official_fact_check_status,
    "UNVERIFIED_OFFICIAL_SOURCE",
  );
});

// ---------------------------------------------------------------------------
// Test 3: finalLegalQA runs and reflects unverified official-source caution
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - finalLegalQA returns WARNING for unverified official sources", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  assert(result.finalLegalQA !== null, "finalLegalQA should be set");
  assertEquals(result.finalLegalQA?.final_legal_qa_status, "WARNING");
});

// ---------------------------------------------------------------------------
// Test 4: pipeline_metadata.pipeline_version is 2.0.0
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - pipeline_metadata.pipeline_version is 2.0.0", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  assertEquals(result.metadata.pipeline_version, "2.0.0");
});

// ---------------------------------------------------------------------------
// Test 5: pipelineWarnings / pipelineErrors are arrays (from orchestrator)
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - pipelineWarnings and pipelineErrors are arrays", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  assert(Array.isArray(result.pipelineWarnings), "pipelineWarnings must be an array");
  assert(Array.isArray(result.pipelineErrors), "pipelineErrors must be an array");
});

// ---------------------------------------------------------------------------
// Test 6: verification stages not duplicated — exactly 8 stages
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - no duplicate stages, exactly 8 total", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  assertEquals(result.stages.length, 8, "Pipeline must have exactly 8 stages");
  const names = result.stages.map((s) => s.name);
  assertEquals(new Set(names).size, 8, "All stage names must be unique");
});

// ---------------------------------------------------------------------------
// Test 7: QA chain skips gracefully when generatedText absent (pre-LLM call)
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - QA stages skip when no generatedText (pre-LLM call)", async () => {
  // Simulates the FIRST pipeline call (before LLM), which has no generatedText
  const result = await runLegalPipeline(
    baseInput(), // no generatedText
    minimalDeps(),
  );

  // citation_verification skips with warning (no text)
  const citStage = result.stages.find((s) => s.name === "citation_verification");
  assertEquals(citStage?.status, "skipped");

  // official_source_fact_check skips (dep absent)
  const factStage = result.stages.find((s) => s.name === "official_source_fact_check");
  assertEquals(factStage?.status, "skipped");

  // final_legal_qa skips (dep absent)
  const qaStage = result.stages.find((s) => s.name === "final_legal_qa");
  assertEquals(qaStage?.status, "skipped");

  // legalCorePrompt was still built
  assert(result.legalCorePrompt.length > 0, "legalCorePrompt should be built even when QA skipped");
});

// ---------------------------------------------------------------------------
// Test 8: backward compatibility — response fields that callers expect still present
// ---------------------------------------------------------------------------

Deno.test("generate-document QA - backward compat fields present in result", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps(),
  );

  // Fields that generate-document maps into the HTTP response
  assert("citationVerification" in result, "citationVerification field must exist");
  assert("officialSourceFactCheck" in result, "officialSourceFactCheck field must exist");
  assert("finalLegalQA" in result, "finalLegalQA field must exist");
  assert("pipelineWarnings" in result, "pipelineWarnings field must exist");
  assert("pipelineErrors" in result, "pipelineErrors field must exist");
  // deprecated alias still present for callers using result.verification
  assert("verification" in result, "deprecated verification alias must exist");
  assertEquals(result.verification, result.citationVerification);
});

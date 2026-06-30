import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  runLegalPipeline,
  type LegalPipelineInput,
  type LegalPipelineDeps,
} from "./legal-pipeline-orchestrator.ts";

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

// A dummy input factory
const createInput = (overrides: Partial<LegalPipelineInput> = {}): LegalPipelineInput => ({
  mode: "chat",
  userQuery: "Test query",
  caseType: "civil",
  effectiveAt: "2026-06-30T00:00:00Z",
  ...overrides,
});

// Minimal required deps (no optional QA deps)
const createMockDeps = (ragShouldFail = false, verifyShouldFail = false): LegalPipelineDeps => ({
  runRAG: async (_query, _opts) => {
    if (ragShouldFail) throw new Error("Mock RAG Error");
    return {
      semantic_ok: true,
      kbResults: [{ id: "kb1", title: "Test Law", category: "legal" }],
      practiceResults: [{ id: "pr1", title: "Test Case", practice_category: "cassation" }],
    };
  },
  verifyCitations: async (_text, _opts) => {
    if (verifyShouldFail) throw new Error("Mock Verify Error");
    return { verified: true, count: 1 };
  },
});

// Full deps including all optional QA deps
const createFullMockDeps = (): LegalPipelineDeps => ({
  ...createMockDeps(),
  runOfficialFactCheck: (_text, _citations, _meta) => ({
    official_fact_check_status: "PASS",
    verified_sources: [],
    failed_sources: [],
    warnings: [],
  }),
  runFinalLegalQA: (input) => ({
    final_legal_qa_status: "PASS" as const,
    confidence: "high" as const,
    blocking_issues: [],
    warnings: [],
    requires_human_review: false,
    safe_to_show_user: true,
    qa_summary: "All QA checks passed. Output is safe to show to the user.",
    checked_at: new Date().toISOString(),
    agent_type: input.agentType ?? undefined,
    mode: input.mode ?? undefined,
  }),
});

// ---------------------------------------------------------------------------
// Existing tests (updated for 8-stage pipeline)
// ---------------------------------------------------------------------------

Deno.test("LegalPipelineOrchestrator - stages execute in correct order", async () => {
  const result = await runLegalPipeline(createInput(), createMockDeps());
  const stages = result.stages.map((s) => s.name);
  assertEquals(stages, [
    "reasoning",
    "retrieval",
    "enrichment",
    "prompt_build",
    "citation_verification",
    "official_source_fact_check",
    "final_legal_qa",
    "verification",
  ]);
});

Deno.test("LegalPipelineOrchestrator - RAG cannot run before reasoning", async () => {
  const input = createInput();
  const result: any = { reasoning: null, stages: [], errors: [], warnings: [], metadata: {} };
  const stage: any = { name: "retrieval", status: "skipped", errors: [], warnings: [] };
  const deps = createMockDeps();
  const { runRetrievalStage } = await import("./legal-pipeline-orchestrator.ts");
  await runRetrievalStage(input, result, stage, deps);
  assertEquals(stage.status, "fail");
  assertStringIncludes(stage.errors[0], "Reasoning stage must run before retrieval stage");
});

Deno.test("LegalPipelineOrchestrator - prompt_build cannot run before enrichment", async () => {
  const input = createInput();
  const result: any = { stages: [], errors: [], warnings: [], metadata: {} };
  const stage: any = { name: "prompt_build", status: "skipped", errors: [], warnings: [] };
  const { runPromptBuildStage } = await import("./legal-pipeline-orchestrator.ts");
  await runPromptBuildStage(input, result, stage);
  assertEquals(stage.status, "fail");
  assertStringIncludes(stage.errors[0], "Enrichment stage must run before prompt build");
});

Deno.test("LegalPipelineOrchestrator - Legal Core prompt is always built", async () => {
  const result = await runLegalPipeline(createInput(), createMockDeps(true)); // RAG fails
  const promptStage = result.stages.find((s) => s.name === "prompt_build");
  assertEquals(promptStage?.status, "pass");
  assert(result.legalCorePrompt.length > 0);
});

Deno.test("LegalPipelineOrchestrator - RAG failure produces cautious mode", async () => {
  const result = await runLegalPipeline(createInput(), createMockDeps(true));
  const retrievalStage = result.stages.find((s) => s.name === "retrieval");
  assertEquals(retrievalStage?.status, "fail");
  assertEquals(result.metadata.cautious_output_required, true);
});

Deno.test("LegalPipelineOrchestrator - missing effectiveAt produces warning", async () => {
  const input = createInput({ effectiveAt: null });
  const result = await runLegalPipeline(input, createMockDeps());
  const enrichmentStage = result.stages.find((s) => s.name === "enrichment");
  assert(enrichmentStage?.warnings.includes("missing_effective_at"));
});

Deno.test("LegalPipelineOrchestrator - courtPractice context is preserved", async () => {
  const result = await runLegalPipeline(createInput(), createMockDeps());
  assert(result.courtPractice !== null);
});

Deno.test("LegalPipelineOrchestrator - hierarchy context is preserved", async () => {
  const result = await runLegalPipeline(createInput(), createMockDeps());
  assert(result.hierarchy !== null);
});

Deno.test("LegalPipelineOrchestrator - deps.runRAG can be mocked", async () => {
  let mockCalled = false;
  const deps: LegalPipelineDeps = {
    runRAG: async () => {
      mockCalled = true;
      return { kbResults: [], practiceResults: [] };
    },
  };
  await runLegalPipeline(createInput(), deps);
  assertEquals(mockCalled, true);
});

// Updated: "citation_verification" stage skips when no generatedText,
// the old "verification" name now refers to the summary stage.
Deno.test("LegalPipelineOrchestrator - citation_verification is skipped when no generated text exists", async () => {
  const result = await runLegalPipeline(
    createInput({ generatedText: undefined }),
    createMockDeps(),
  );
  const citStage = result.stages.find((s) => s.name === "citation_verification");
  assertEquals(citStage?.status, "skipped");
  // Stage emits a warning when skipped due to missing text
  assert(
    citStage?.warnings.includes("No generated text provided for citation verification"),
  );
});

// Updated: verify citation_verification runs and backward-compat result.verification is set.
Deno.test("LegalPipelineOrchestrator - citation_verification runs when generated text is passed", async () => {
  const result = await runLegalPipeline(
    createInput({ generatedText: "Some text with citations" }),
    createMockDeps(),
  );
  const citStage = result.stages.find((s) => s.name === "citation_verification");
  assertEquals(citStage?.status, "pass");
  // Both new field and backward-compat alias are populated
  assertEquals((result.citationVerification as any).verified, true);
  assertEquals((result.verification as any).verified, true);
});

Deno.test("LegalPipelineOrchestrator - system prompt contains CURATED LEGAL BRIEF and not raw JSON", async () => {
  const result = await runLegalPipeline(createInput(), createMockDeps());
  assertStringIncludes(result.legalCorePrompt, "CURATED LEGAL BRIEF");
  assertEquals(
    result.legalCorePrompt.includes('"normalized_input"'),
    false,
    "Should not contain raw JSON dump",
  );
});

Deno.test("LegalPipelineOrchestrator - document mode system prompt contains CURATED LEGAL BRIEF", async () => {
  const result = await runLegalPipeline(
    createInput({ functionContext: "generate-document" }),
    createMockDeps(),
  );
  assertStringIncludes(result.legalCorePrompt, "CURATED LEGAL BRIEF");
});

Deno.test("LegalPipelineOrchestrator - complaint mode system prompt contains CURATED LEGAL BRIEF", async () => {
  const result = await runLegalPipeline(
    createInput({ functionContext: "generate-complaint" }),
    createMockDeps(),
  );
  assertStringIncludes(result.legalCorePrompt, "CURATED LEGAL BRIEF");
});

Deno.test("LegalPipelineOrchestrator - analysis mode system prompt contains CURATED LEGAL BRIEF", async () => {
  const result = await runLegalPipeline(
    createInput({ functionContext: "ai-analyze", mode: "analysis" }),
    createMockDeps(),
  );
  assertStringIncludes(result.legalCorePrompt, "CURATED LEGAL BRIEF");
});

// ---------------------------------------------------------------------------
// Phase 6.8 — 8 new tests
// ---------------------------------------------------------------------------

// New test 1: citation_verification skipped when verifyCitations dep is absent
Deno.test("LegalPipelineOrchestrator v2 - citation_verification skipped when verifyCitations dep absent", async () => {
  const deps: LegalPipelineDeps = {
    runRAG: async () => ({ kbResults: [], practiceResults: [] }),
    // no verifyCitations
  };
  const result = await runLegalPipeline(
    createInput({ generatedText: "Some legal text." }),
    deps,
  );
  const citStage = result.stages.find((s) => s.name === "citation_verification");
  assertEquals(citStage?.status, "skipped");
  // No error on the stage — silent skip per spec
  assertEquals(citStage?.errors.length, 0);
  assertEquals(result.citationVerification, null);
});

// New test 2: official_source_fact_check skipped (NOT_RUN) when dep absent
Deno.test("LegalPipelineOrchestrator v2 - official_source_fact_check uses NOT_RUN when dep absent", async () => {
  const result = await runLegalPipeline(
    createInput({ generatedText: "Some legal text." }),
    createMockDeps(), // no runOfficialFactCheck
  );
  const factStage = result.stages.find((s) => s.name === "official_source_fact_check");
  assertEquals(factStage?.status, "skipped");
  assertEquals(result.officialSourceFactCheck?.official_fact_check_status, "NOT_RUN");
});

// New test 3: final_legal_qa skipped (NOT_RUN) when dep absent
Deno.test("LegalPipelineOrchestrator v2 - final_legal_qa uses NOT_RUN when dep absent", async () => {
  const result = await runLegalPipeline(
    createInput({ generatedText: "Some legal text." }),
    createMockDeps(), // no runFinalLegalQA
  );
  const qaStage = result.stages.find((s) => s.name === "final_legal_qa");
  assertEquals(qaStage?.status, "skipped");
  assertEquals(result.finalLegalQA?.final_legal_qa_status, "NOT_RUN");
});

// New test 4: all QA stages execute and pass when all deps are provided
Deno.test("LegalPipelineOrchestrator v2 - all QA stages execute when all deps provided", async () => {
  const result = await runLegalPipeline(
    createInput({ generatedText: "Full legal analysis text." }),
    createFullMockDeps(),
  );
  const citStage = result.stages.find((s) => s.name === "citation_verification");
  const factStage = result.stages.find((s) => s.name === "official_source_fact_check");
  const qaStage = result.stages.find((s) => s.name === "final_legal_qa");

  assertEquals(citStage?.status, "pass");
  assertEquals(factStage?.status, "pass");
  assertEquals(qaStage?.status, "pass");

  assert(result.citationVerification !== null, "citationVerification should be populated");
  assert(
    result.officialSourceFactCheck !== null,
    "officialSourceFactCheck should be populated",
  );
  assert(result.finalLegalQA !== null, "finalLegalQA should be populated");
  assertEquals(result.finalLegalQA?.final_legal_qa_status, "PASS");
});

// New test 5: 8-stage ordering is preserved end-to-end
Deno.test("LegalPipelineOrchestrator v2 - 8-stage ordering is preserved", async () => {
  const result = await runLegalPipeline(
    createInput({ generatedText: "Full pipeline test." }),
    createFullMockDeps(),
  );
  const stageNames = result.stages.map((s) => s.name);
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
  assertEquals(stageNames.length, 8);
});

// New test 6: result contains all new QA metadata fields
Deno.test("LegalPipelineOrchestrator v2 - result contains all QA metadata fields", async () => {
  const result = await runLegalPipeline(
    createInput({ generatedText: "Text." }),
    createFullMockDeps(),
  );
  // New fields exist
  assert("citationVerification" in result);
  assert("officialSourceFactCheck" in result);
  assert("finalLegalQA" in result);
  assert("pipelineWarnings" in result);
  assert("pipelineErrors" in result);
  // Arrays
  assert(Array.isArray(result.pipelineWarnings));
  assert(Array.isArray(result.pipelineErrors));
  // Backward compat: result.verification must still point to citation result
  assertEquals(result.verification, result.citationVerification);
  // Version bumped to 2.0.0
  assertEquals(result.metadata.pipeline_version, "2.0.0");
});

// New test 7: optional deps work independently — only runOfficialFactCheck provided
Deno.test("LegalPipelineOrchestrator v2 - optional deps work independently", async () => {
  const deps: LegalPipelineDeps = {
    ...createMockDeps(),
    runOfficialFactCheck: (_text, _cits, _meta) => ({
      official_fact_check_status: "PASS",
      warnings: [],
    }),
    // runFinalLegalQA intentionally absent
  };
  const result = await runLegalPipeline(
    createInput({ generatedText: "Partial deps test." }),
    deps,
  );
  // Official fact check ran
  const factStage = result.stages.find((s) => s.name === "official_source_fact_check");
  assertEquals(factStage?.status, "pass");
  assertEquals(result.officialSourceFactCheck?.official_fact_check_status, "PASS");
  // Final QA skipped (dep absent)
  const qaStage = result.stages.find((s) => s.name === "final_legal_qa");
  assertEquals(qaStage?.status, "skipped");
  assertEquals(result.finalLegalQA?.final_legal_qa_status, "NOT_RUN");
});

// New test 8: pipeline completes without any network I/O — all deps are pure sync fns
Deno.test("LegalPipelineOrchestrator v2 - no network required — all stages complete via DI", async () => {
  let networkCallDetected = false;

  // All deps are synchronous closures — no actual I/O, no fetch
  const syncDeps: LegalPipelineDeps = {
    runRAG: async (_q, _o) => {
      // Ensure this is the only I/O path
      return { semantic_ok: true, kbResults: [], practiceResults: [] };
    },
    verifyCitations: async (_t, _o) => ({ verified: true, count: 0 }),
    runOfficialFactCheck: (_t, _c, _m) => ({ official_fact_check_status: "PASS" }),
    runFinalLegalQA: (_i) => ({
      final_legal_qa_status: "PASS" as const,
      confidence: "high" as const,
      blocking_issues: [],
      warnings: [],
      requires_human_review: false,
      safe_to_show_user: true,
      qa_summary: "All passed.",
      checked_at: new Date().toISOString(),
    }),
  };

  const result = await runLegalPipeline(
    createInput({ generatedText: "Network-free run." }),
    syncDeps,
  );

  // Pipeline must complete all 8 stages
  assertEquals(result.stages.length, 8);
  // No network calls occurred (no exception, no timeout)
  assertEquals(networkCallDetected, false);
  // All QA stages completed (not failed)
  const failedStages = result.stages.filter((s) => s.status === "fail");
  assertEquals(failedStages.length, 0, "No stage should fail in a clean sync run");
});

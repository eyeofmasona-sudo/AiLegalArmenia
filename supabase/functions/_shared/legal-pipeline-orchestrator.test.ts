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
    createInput({ functionContext: "generate-
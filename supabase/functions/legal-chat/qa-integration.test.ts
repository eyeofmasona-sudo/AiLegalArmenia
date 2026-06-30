/**
 * Phase 6.11 — legal-chat QA Chain Integration Tests
 *
 * Validates the streaming endpoint wiring without DB, network, RAG, or LLM.
 * Runtime QA behavior is exercised through Orchestrator v2 with pure mocks;
 * SSE/callStreamBypass wiring is checked statically.
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

const GENERATED_TEXT = "Legal chat answer with [ID: 11111111-1111-4111-8111-111111111111].";

const baseInput = (overrides: Partial<LegalPipelineInput> = {}): LegalPipelineInput => ({
  mode: "chat",
  userQuery: "Explain a civil law issue",
  caseText: "Recent conversation context",
  language: "auto",
  effectiveAt: "2026-06-30",
  functionContext: "legal-chat",
  ...overrides,
});

const fullQaDeps = (cachedRagResult: unknown): LegalPipelineDeps => ({
  runRAG: async () => cachedRagResult,
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

Deno.test("legal-chat QA - uses Orchestrator v2 metadata", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps({ kbResults: [{ id: "kb-1" }], practiceResults: [], semantic_ok: true }),
  );

  assert(result.citationVerification !== null);
  assert(result.officialSourceFactCheck !== null);
  assert(result.finalLegalQA !== null);
  assertEquals(result.metadata.pipeline_version, "2.0.0");
  assert(Array.isArray(result.pipelineWarnings));
  assert(Array.isArray(result.pipelineErrors));
});

Deno.test("legal-chat QA - second pipeline uses cachedRagResult only", async () => {
  let ragCalls = 0;
  const cachedRagResult = { kbResults: [{ id: "cached-kb" }], practiceResults: [], semantic_ok: true };
  const deps = fullQaDeps(cachedRagResult);
  deps.runRAG = async () => {
    ragCalls += 1;
    return cachedRagResult;
  };

  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    deps,
  );

  assertEquals(ragCalls, 1);
  assertEquals(result.rag, cachedRagResult);
});

Deno.test("legal-chat QA - QA stages run after generated text exists", async () => {
  const result = await runLegalPipeline(
    baseInput({ generatedText: GENERATED_TEXT }),
    fullQaDeps({ kbResults: [], practiceResults: [], semantic_ok: true }),
  );

  assertEquals(result.stages.map((stage) => stage.name), [
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

Deno.test("legal-chat QA - streaming call remains callStreamBypass", async () => {
  const source = await Deno.readTextFile("supabase/functions/legal-chat/index.ts");

  assertStringIncludes(source, "callStreamBypass");
  assertStringIncludes(source, "bypassReason: \"streaming\"");
  assertStringIncludes(source, "const { readable, writable } = new TransformStream");
  assertStringIncludes(source, "response.body!.pipeTo(writable)");
});

Deno.test("legal-chat QA - post-stream QA uses cachedRagResult without search calls", async () => {
  const source = await Deno.readTextFile("supabase/functions/legal-chat/index.ts");
  const qaBlock = source.match(/const qaResult = await runLegalPipeline[\s\S]*?const citationVerification/)?.[0] ?? "";

  assertStringIncludes(qaBlock, "generatedText: streamedText");
  assertStringIncludes(qaBlock, "cachedRagResult ??");
  assertEquals(qaBlock.includes("searchKB("), false);
  assertEquals(qaBlock.includes("searchPractice("), false);
  assertStringIncludes(qaBlock, "verifyCitationsInText");
  assertStringIncludes(qaBlock, "runOfficialSourceFactCheckStub");
  assertStringIncludes(qaBlock, "runFinalLegalQA");
});

Deno.test("legal-chat QA - citation verification remains post-generation", async () => {
  const source = await Deno.readTextFile("supabase/functions/legal-chat/index.ts");
  const streamedTextIndex = source.indexOf("streamedText += delta");
  const qaIndex = source.indexOf("const qaResult = await runLegalPipeline");
  const doneIndex = source.indexOf("data: [DONE]", qaIndex);

  assert(streamedTextIndex > 0);
  assert(qaIndex > streamedTextIndex);
  assert(doneIndex > qaIndex);
});

Deno.test("legal-chat QA - SSE metadata preserves backward compatibility", async () => {
  const source = await Deno.readTextFile("supabase/functions/legal-chat/index.ts");

  assertStringIncludes(source, "event: legal_reasoning");
  assertStringIncludes(source, "event: pipeline_metadata");
  assertStringIncludes(source, "event: citation_validation");
  assertStringIncludes(source, "event: citation_verification");
  assertStringIncludes(source, "event: official_source_fact_check");
  assertStringIncludes(source, "event: final_legal_qa");
  assertStringIncludes(source, "event: pipeline_warnings");
  assertStringIncludes(source, "event: pipeline_errors");
});

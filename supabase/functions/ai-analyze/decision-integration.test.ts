import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

const SOURCE_PATH = "supabase/functions/ai-analyze/index.ts";

Deno.test("ai-analyze decision - Decision creates after QA", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  const qaCall = source.indexOf("const qaResult = await runLegalPipeline");
  const citationAssignment = source.indexOf("const citationValidation = qaResult.citationVerification", qaCall);
  const decisionBuild = source.indexOf("const legalDecision = buildLegalDecisionObject", citationAssignment);
  const repositorySave = source.indexOf("saveLegalDecisionSnapshot", decisionBuild);

  assert(qaCall > 0);
  assert(citationAssignment > qaCall);
  assert(decisionBuild > citationAssignment);
  assert(repositorySave > decisionBuild);
});

Deno.test("ai-analyze decision - Decision does not create before QA", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  const qaCall = source.indexOf("const qaResult = await runLegalPipeline");
  const firstDecisionBuild = source.indexOf("const legalDecision = buildLegalDecisionObject");

  assert(qaCall > 0);
  assert(firstDecisionBuild > qaCall);
});

Deno.test("ai-analyze decision - Decision builds from Final QA", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "final_legal_qa: qaResult.finalLegalQA");
  assertStringIncludes(source, "citation_validation: citationValidation");
  assertStringIncludes(source, "official_source_fact_check: qaResult.officialSourceFactCheck");
  assertStringIncludes(source, "source_hierarchy: qaResult.hierarchy");
  assertStringIncludes(source, "court_practice: qaResult.courtPractice");
});

Deno.test("ai-analyze decision - Repository called only if caseId exists", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  const decisionBuild = source.indexOf("const legalDecision = buildLegalDecisionObject");
  const ifCaseId = source.indexOf("if (caseId) {", decisionBuild);
  const repositorySave = source.indexOf("saveLegalDecisionSnapshot", ifCaseId);

  assert(ifCaseId > decisionBuild);
  assert(repositorySave > ifCaseId);
});

Deno.test("ai-analyze decision - Repository not called without caseId", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "let decisionSummary: DecisionSummary = summarizeDecision(legalDecision, null, false);");
  assertStringIncludes(source, "if (caseId) {");
  assertStringIncludes(source, "decision_saved: decisionSaved");
});

Deno.test("ai-analyze decision - Duplicate version uses existing repository row", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "repository_record_id: saved?.data?.id ?? null");
  assertStringIncludes(source, "supersedes_decision_id: saved?.data?.supersedes_decision_id ?? saved?.superseded_decision_id ?? null");
  assertEquals((source.match(/saveLegalDecisionSnapshot\(/g) ?? []).length, 1);
});

Deno.test("ai-analyze decision - Repository error does not break endpoint", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "let decisionRepositoryError: string | null = null;");
  assertStringIncludes(source, "if (savedDecision.error) {");
  assertStringIncludes(source, "} catch (error) {");
  assertStringIncludes(source, "decision_repository_error: decisionRepositoryError");
  assertEquals(source.includes("throw decisionRepositoryError"), false);
});

Deno.test("ai-analyze decision - Decision summary returns only short fields", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  const summaryStart = source.indexOf("function summarizeDecision");
  const summaryEnd = source.indexOf("function repositoryErrorMessage", summaryStart);
  const summary = source.slice(summaryStart, summaryEnd);

  assertStringIncludes(summary, "decision_id: decision.decision_id");
  assertStringIncludes(summary, "status: decision.status");
  assertStringIncludes(summary, "confidence: decision.confidence");
  assertStringIncludes(summary, "probability_of_success: decision.probability_of_success");
  assertStringIncludes(summary, "version_hash: decision.version_hash");
  assertStringIncludes(summary, "decision_saved: decisionSaved");
  assertStringIncludes(summary, "repository_record_id:");
  assertStringIncludes(summary, "supersedes_decision_id:");
  assertStringIncludes(summary, "created_at:");
  assertEquals(summary.includes("conflicts_and_gaps"), false);
  assertEquals(summary.includes("action_plan"), false);
});

Deno.test("ai-analyze decision - Version hash preserved", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "version_hash: decision.version_hash");
});

Deno.test("ai-analyze decision - Repository receives immutable Decision object", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "const legalDecision = buildLegalDecisionObject({");
  assertStringIncludes(source, "saveLegalDecisionSnapshot(supabase as unknown as LegalDecisionRepositoryClient, legalDecision");
  assertEquals(source.includes("saveLegalDecisionSnapshot(supabase as unknown as LegalDecisionRepositoryClient, decisionSummary"), false);
});

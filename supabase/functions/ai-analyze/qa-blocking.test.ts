import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

const SOURCE_PATH = "supabase/functions/ai-analyze/index.ts";
const BLOCKED_TEXT =
  "Վերլուծությունը չի կարող ցուցադրվել, քանի որ վերջնական իրավական որակի ստուգումը հայտնաբերել է բարձր ռիսկային խնդիրներ։ Խնդրում ենք դիմել իրավաբանի կամ կրկնել հարցումը՝ լրացուցիչ փաստերով։";

Deno.test("ai-analyze QA blocking - PASS returns original analysis", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  const helper = helperSource(source);

  assertStringIncludes(source, "const publicAiResponseText = blockAnalysisForFinalQA ? FINAL_LEGAL_QA_BLOCKED_ANALYSIS_HY : aiResponseText;");
  assertEquals(helper.includes('finalLegalQA.final_legal_qa_status === "PASS"'), false);
});

Deno.test("ai-analyze QA blocking - WARNING returns original analysis", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  const helper = helperSource(source);

  assertEquals(helper.includes('finalLegalQA.final_legal_qa_status === "WARNING"'), false);
  assertEquals(helper.includes("WARNING"), false);
});

Deno.test("ai-analyze QA blocking - HUMAN_REVIEW safe true returns original analysis with metadata", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);
  const helper = helperSource(source);

  assertEquals(helper.includes('finalLegalQA.final_legal_qa_status === "REQUIRES_HUMAN_REVIEW"'), false);
  assertStringIncludes(source, "final_legal_qa: qaResult.finalLegalQA");
});

Deno.test("ai-analyze QA blocking - HUMAN_REVIEW safe false blocks analysis text", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "if (finalLegalQA.safe_to_show_user === false) return true;");
  assertStringIncludes(source, BLOCKED_TEXT);
});

Deno.test("ai-analyze QA blocking - FAIL blocks analysis text", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, 'if (finalLegalQA.final_legal_qa_status === "FAIL") return true;');
  assertStringIncludes(source, "analysis: publicAiResponseText");
});

Deno.test("ai-analyze QA blocking - blocked response still includes final QA metadata", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "final_legal_qa: qaResult.finalLegalQA");
  assertStringIncludes(source, "official_source_fact_check: qaResult.officialSourceFactCheck");
  assertStringIncludes(source, "validation: citationValidation");
  assertStringIncludes(source, "pipeline_metadata: qaResult.metadata");
});

Deno.test("ai-analyze QA blocking - blocked response still includes decision summary", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertStringIncludes(source, "decision: decisionSummary");
});

Deno.test("ai-analyze QA blocking - public response fields do not include raw unsafe text", async () => {
  const source = await Deno.readTextFile(SOURCE_PATH);

  assertEquals(source.includes("analysis: aiResponseText"), false);
  assertEquals(source.includes("draft_text: aiResponseText"), false);
  assertEquals(source.includes("[responseKey]: structuredJson"), false);
  assertStringIncludes(source, "analysis: publicAiResponseText");
  assertStringIncludes(source, "draft_text: publicAiResponseText");
  assertStringIncludes(source, "[responseKey]: publicStructuredJson");
});

function helperSource(source: string): string {
  const start = source.indexOf("function shouldBlockAnalysisForFinalQA");
  const end = source.indexOf("serve(async", start);
  assert(start > 0, "helper should exist");
  assert(end > start, "helper should appear before serve");
  return source.slice(start, end);
}

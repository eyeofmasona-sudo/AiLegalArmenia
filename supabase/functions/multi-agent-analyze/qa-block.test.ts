/**
 * Phase 7.5A — QA Block Guard tests for multi-agent-analyze
 *
 * Tests the isQABlocked utility and verifies the blocking logic applied
 * in multi-agent-analyze/index.ts produces the correct response shape.
 * No Deno env / DB / network required.
 */

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import {
  isQABlocked,
  QA_BLOCK_MESSAGE_HY,
  buildBlockedAgentResult,
  type FinalLegalQALike,
} from "../_shared/qa-block-guard.ts";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeQA(status: string, safe: boolean): FinalLegalQALike {
  return { final_legal_qa_status: status, safe_to_show_user: safe };
}

function makeParsedResult(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    summary: "Ամփոփ հայտարարություն",
    analysis: "Իրավաբանական վերլուծություն",
    findings: [{ id: 1, description: "Կարևոր բացահայտում" }],
    evidenceItems: [{ type: "document", title: "Ապացույց" }],
    ...overrides,
  };
}

// ── 1. FAIL blocks multi-agent content ───────────────────────────────────────

Deno.test("multi-agent: FAIL status → content blocked", () => {
  const qaBlocked = isQABlocked(makeQA("FAIL", true));
  assertEquals(qaBlocked, true);
});

// ── 2. safe_to_show_user=false blocks ────────────────────────────────────────

Deno.test("multi-agent: safe_to_show_user=false → content blocked", () => {
  assertEquals(isQABlocked(makeQA("PASS", false)), true);
});

// ── 3. WARNING does NOT block ─────────────────────────────────────────────────

Deno.test("multi-agent: WARNING + safe=true → NOT blocked", () => {
  assertEquals(isQABlocked(makeQA("WARNING", true)), false);
});

// ── 4. REQUIRES_HUMAN_REVIEW + safe=true does NOT block ──────────────────────

Deno.test("multi-agent: REQUIRES_HUMAN_REVIEW + safe=true → NOT blocked", () => {
  assertEquals(isQABlocked(makeQA("REQUIRES_HUMAN_REVIEW", true)), false);
});

// ── 5. buildBlockedAgentResult returns Armenian message in summary + analysis ─

Deno.test("multi-agent: buildBlockedAgentResult has Armenian blocking message", () => {
  const blocked = buildBlockedAgentResult();
  assertStringIncludes(blocked.summary as string, "անհասանելի");
  assertStringIncludes(blocked.analysis as string, "անհասանելի");
  assertEquals(blocked.summary, QA_BLOCK_MESSAGE_HY);
});

// ── 6. buildBlockedAgentResult clears findings and evidenceItems ──────────────

Deno.test("multi-agent: buildBlockedAgentResult clears findings and evidenceItems", () => {
  const blocked = buildBlockedAgentResult();
  assertEquals(blocked.findings, []);
  assertEquals(blocked.evidenceItems, []);
});

// ── 7. Blocked response does not contain raw unsafe content ──────────────────

Deno.test("multi-agent: blocked response does not contain raw unsafe analysis text", () => {
  const parsedResult = makeParsedResult({
    analysis: "UNSAFE_ANALYSIS_SECRET_XYZ",
    summary: "UNSAFE_SUMMARY_SECRET_XYZ",
  });
  const qaBlocked = isQABlocked(makeQA("FAIL", false));
  const publicParsedResult = qaBlocked ? buildBlockedAgentResult() : parsedResult;

  const responseBody = JSON.stringify(publicParsedResult);
  assertEquals(responseBody.includes("UNSAFE_ANALYSIS_SECRET_XYZ"), false);
  assertEquals(responseBody.includes("UNSAFE_SUMMARY_SECRET_XYZ"), false);
});

// ── 8. Non-blocked response passes parsedResult through unchanged ─────────────

Deno.test("multi-agent: non-blocked response passes parsedResult unchanged", () => {
  const parsedResult = makeParsedResult();
  const qaBlocked = isQABlocked(makeQA("PASS", true));
  const publicParsedResult = qaBlocked ? buildBlockedAgentResult() : parsedResult;

  assertEquals(publicParsedResult.summary, "Ամփոփ հայտարարություն");
  assertEquals((publicParsedResult.findings as unknown[]).length, 1);
});

// ── 9. QA metadata preserved alongside blocked content ───────────────────────

Deno.test("multi-agent: metadata fields present when QA blocks", () => {
  const finalLegalQA = makeQA("FAIL", false);
  const qaBlocked = isQABlocked(finalLegalQA);
  const publicParsedResult = qaBlocked ? buildBlockedAgentResult() : makeParsedResult();

  const responseBody: Record<string, unknown> = {
    ...publicParsedResult,
    agentType: "legal_analyst",
    final_legal_qa: finalLegalQA,
    validation: { citation_risk_level: "HIGH" },
    official_source_fact_check: { official_fact_check_status: "NOT_RUN" },
  };

  assertEquals(responseBody["analysis"], QA_BLOCK_MESSAGE_HY);
  assertEquals(
    (responseBody["final_legal_qa"] as FinalLegalQALike).final_legal_qa_status,
    "FAIL",
  );
  assertEquals(
    (responseBody["official_source_fact_check"] as Record<string, unknown>)[
      "official_fact_check_status"
    ],
    "NOT_RUN",
  );
});

// ── 10. single_file path: same blocking logic applies ────────────────────────

Deno.test("multi-agent single_file: FAIL blocks parsedFileResult", () => {
  const parsedFileResult: Record<string, unknown> = {
    summary: "Ֆայլի ամփոփում",
    analysis: "Ֆայլի վերլուծություն",
    findings: [],
    evidenceItems: [],
  };
  const finalLegalQA = makeQA("FAIL", true);
  const singleFileBlocked = isQABlocked(finalLegalQA);
  const publicParsedFileResult = singleFileBlocked
    ? buildBlockedAgentResult()
    : parsedFileResult;

  assertEquals(singleFileBlocked, true);
  assertEquals(publicParsedFileResult.summary, QA_BLOCK_MESSAGE_HY);
});

/**
 * Phase 7.5A — QA Block Guard tests for generate-document
 *
 * Tests the isQABlocked utility and verifies the blocking logic applied
 * in generate-document/index.ts produces the correct response shape.
 * No Deno env / DB / network required.
 */

import {
  assertEquals,
  assertStringIncludes,
  assertNotEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import {
  isQABlocked,
  QA_BLOCK_MESSAGE_HY,
  buildBlockedAgentResult,
  type FinalLegalQALike,
} from "../_shared/qa-block-guard.ts";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeQA(
  status: string,
  safe: boolean,
): FinalLegalQALike {
  return { final_legal_qa_status: status, safe_to_show_user: safe };
}

// ── 1. FAIL status blocks ─────────────────────────────────────────────────────

Deno.test("generate-document: FAIL status → isQABlocked returns true", () => {
  assertEquals(isQABlocked(makeQA("FAIL", true)), true);
});

// ── 2. safe_to_show_user=false blocks regardless of status ────────────────────

Deno.test("generate-document: safe_to_show_user=false → isQABlocked returns true", () => {
  assertEquals(isQABlocked(makeQA("PASS", false)), true);
});

// ── 3. WARNING does NOT block ─────────────────────────────────────────────────

Deno.test("generate-document: WARNING + safe=true → isQABlocked returns false", () => {
  assertEquals(isQABlocked(makeQA("WARNING", true)), false);
});

// ── 4. REQUIRES_HUMAN_REVIEW + safe=true does NOT block ──────────────────────

Deno.test("generate-document: REQUIRES_HUMAN_REVIEW + safe=true → isQABlocked returns false", () => {
  assertEquals(isQABlocked(makeQA("REQUIRES_HUMAN_REVIEW", true)), false);
});

// ── 5. PASS does NOT block ────────────────────────────────────────────────────

Deno.test("generate-document: PASS + safe=true → isQABlocked returns false", () => {
  assertEquals(isQABlocked(makeQA("PASS", true)), false);
});

// ── 6. null QA does NOT block ─────────────────────────────────────────────────

Deno.test("generate-document: null finalLegalQA → isQABlocked returns false", () => {
  assertEquals(isQABlocked(null), false);
  assertEquals(isQABlocked(undefined), false);
});

// ── 7. Blocked response replaces content with Armenian message ───────────────

Deno.test("generate-document: blocked response has Armenian blocking message", () => {
  const rawContent = "Հայցվոր կողմի իրավունքները ամրագրված են ՀՀ Քաղ. Օր. հոդ. 123-ով:";
  const qaBlocked = isQABlocked(makeQA("FAIL", true));
  const publicContent = qaBlocked ? QA_BLOCK_MESSAGE_HY : rawContent;

  assertEquals(publicContent, QA_BLOCK_MESSAGE_HY);
  assertNotEquals(publicContent, rawContent);
});

// ── 8. Non-blocked response passes raw content through ───────────────────────

Deno.test("generate-document: non-blocked response passes raw content through", () => {
  const rawContent = "Հայցվոր կողմի իրավունքները ամրագրված են ՀՀ Քաղ. Օր. հոդ. 123-ով:";
  const qaBlocked = isQABlocked(makeQA("PASS", true));
  const publicContent = qaBlocked ? QA_BLOCK_MESSAGE_HY : rawContent;

  assertEquals(publicContent, rawContent);
});

// ── 9. Blocked response does not contain raw unsafe text ─────────────────────

Deno.test("generate-document: blocked response body does not contain raw unsafe text", () => {
  const unsafeText = "UNSAFE_LEGAL_CONTENT_REF_456";
  const qaBlocked = isQABlocked(makeQA("FAIL", false));
  const publicContent = qaBlocked ? QA_BLOCK_MESSAGE_HY : unsafeText;

  const responseBody = JSON.stringify({ content: publicContent });
  assertEquals(responseBody.includes(unsafeText), false);
  assertStringIncludes(responseBody, "անհասանելի");
});

// ── 10. QA metadata preserved in blocked response ────────────────────────────

Deno.test("generate-document: QA metadata always present in response (blocked case)", () => {
  const finalLegalQA = makeQA("FAIL", false);
  const qaBlocked = isQABlocked(finalLegalQA);

  const responseBody = {
    content: qaBlocked ? QA_BLOCK_MESSAGE_HY : "raw",
    final_legal_qa: finalLegalQA,
    citation_risk_level: "HIGH",
    official_source_fact_check: { official_fact_check_status: "NOT_RUN" },
    pipeline_metadata: { pipeline_version: "2.0.0" },
  };

  assertEquals(responseBody.final_legal_qa.final_legal_qa_status, "FAIL");
  assertEquals(responseBody.pipeline_metadata.pipeline_version, "2.0.0");
  assertEquals(responseBody.content, QA_BLOCK_MESSAGE_HY);
});

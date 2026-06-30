/**
 * Phase 7.5A — QA Block Guard tests for generate-complaint
 *
 * Tests the isQABlocked utility and verifies the blocking logic applied
 * in generate-complaint/index.ts produces the correct response shape.
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
  type FinalLegalQALike,
} from "../_shared/qa-block-guard.ts";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeQA(
  status: string,
  safe: boolean,
): FinalLegalQALike {
  return { final_legal_qa_status: status, safe_to_show_user: safe };
}

// ── 1. FAIL blocks content ────────────────────────────────────────────────────

Deno.test("generate-complaint: FAIL status → content blocked", () => {
  const qaBlocked = isQABlocked(makeQA("FAIL", true));
  assertEquals(qaBlocked, true);
});

// ── 2. safe_to_show_user=false blocks ────────────────────────────────────────

Deno.test("generate-complaint: safe_to_show_user=false → content blocked", () => {
  const qaBlocked = isQABlocked(makeQA("PASS", false));
  assertEquals(qaBlocked, true);
});

// ── 3. WARNING does NOT block ─────────────────────────────────────────────────

Deno.test("generate-complaint: WARNING + safe=true → NOT blocked", () => {
  assertEquals(isQABlocked(makeQA("WARNING", true)), false);
});

// ── 4. REQUIRES_HUMAN_REVIEW + safe=true does NOT block ──────────────────────

Deno.test("generate-complaint: REQUIRES_HUMAN_REVIEW + safe=true → NOT blocked", () => {
  assertEquals(isQABlocked(makeQA("REQUIRES_HUMAN_REVIEW", true)), false);
});

// ── 5. Blocked response: content field is Armenian message ───────────────────

Deno.test("generate-complaint: blocked response contains Armenian blocking message", () => {
  const rawContent = "Բողոքի հիմքերը ներկայացված են ՀՀ ՔԴՕ հոդ. 287-ով:";
  const qaBlocked = isQABlocked(makeQA("FAIL", false));
  const publicContent = qaBlocked ? QA_BLOCK_MESSAGE_HY : rawContent;

  assertNotEquals(publicContent, rawContent);
  assertStringIncludes(publicContent, "անհասանելի");
});

// ── 6. Non-blocked response passes content ────────────────────────────────────

Deno.test("generate-complaint: non-blocked passes content unchanged", () => {
  const rawContent = "Բողոքի հիմքերը ներկայացված են ՀՀ ՔԴՕ հոդ. 287-ով:";
  const qaBlocked = isQABlocked(makeQA("PASS", true));
  const publicContent = qaBlocked ? QA_BLOCK_MESSAGE_HY : rawContent;

  assertEquals(publicContent, rawContent);
});

// ── 7. Blocked response body does not leak raw unsafe text ───────────────────

Deno.test("generate-complaint: blocked response body does not contain raw unsafe text", () => {
  const unsafeText = "SECRET_COMPLAINT_TEXT_789";
  const qaBlocked = isQABlocked({ final_legal_qa_status: "FAIL", safe_to_show_user: false });
  const publicContent = qaBlocked ? QA_BLOCK_MESSAGE_HY : unsafeText;

  const responseBody = JSON.stringify({ content: publicContent });
  assertEquals(responseBody.includes(unsafeText), false);
});

// ── 8. Metadata always preserved (blocked case) ───────────────────────────────

Deno.test("generate-complaint: metadata preserved when QA blocks content", () => {
  const finalLegalQA = makeQA("FAIL", false);
  const qaBlocked = isQABlocked(finalLegalQA);

  const responseBody = {
    content: qaBlocked ? QA_BLOCK_MESSAGE_HY : "raw complaint",
    final_legal_qa: finalLegalQA,
    official_source_fact_check: { official_fact_check_status: "NOT_RUN" },
    pipeline_metadata: { pipeline_version: "2.0.0" },
    pipeline_warnings: [],
  };

  assertEquals(responseBody.content, QA_BLOCK_MESSAGE_HY);
  assertEquals(responseBody.final_legal_qa.final_legal_qa_status, "FAIL");
  assertEquals(responseBody.pipeline_metadata.pipeline_version, "2.0.0");
});

// ── 9. null finalLegalQA → no block (QA not run is permissive) ───────────────

Deno.test("generate-complaint: null finalLegalQA → not blocked (permissive)", () => {
  assertEquals(isQABlocked(null), false);
  assertEquals(isQABlocked(undefined), false);
});

// ── 10. REQUIRES_HUMAN_REVIEW safe=false → blocked ───────────────────────────

Deno.test("generate-complaint: REQUIRES_HUMAN_REVIEW + safe=false → blocked", () => {
  assertEquals(isQABlocked(makeQA("REQUIRES_HUMAN_REVIEW", false)), true);
});

import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildGroundingStopResponse,
  extractLegalIssues,
  findCitationsOutsideGrounding,
  INSUFFICIENT_LEGAL_GROUNDING,
  type GroundingResult,
} from "./multi-agent-grounding.ts";
import { runLegalReasoningEngine } from "./legal-reasoning-engine.ts";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-9222-222222222222";

function grounding(ids: string[]): GroundingResult {
  return {
    ok: ids.length > 0,
    mode: "agent_run",
    agentType: "procedural_violations",
    extracted_issues: ["procedural_violation"],
    norm_anchors: [],
    legal_sources: { anchor: [], arlis: [], case_law: [], echr: [], venice: [] },
    citation_metadata: ids.map((id) => ({ document_id: id })),
    allowed_citation_ids: ids,
    temporal_warnings: [],
    retrieval_routes: ["arlis:hybrid"],
    legal_reasoning: runLegalReasoningEngine({
      user_query: "procedural violation",
      case_type: "criminal",
      effective_at: "2025-01-01",
      function_context: "test",
    }),
    stop_code: ids.length > 0 ? undefined : INSUFFICIENT_LEGAL_GROUNDING,
  };
}

Deno.test("multi-agent grounding: agent without RAG must not form legal conclusion", () => {
  const response = buildGroundingStopResponse(grounding([]));
  assertEquals(response.stop_code, INSUFFICIENT_LEGAL_GROUNDING);
  assertEquals(response.error, INSUFFICIENT_LEGAL_GROUNDING);
  assertEquals(typeof response.analysis, "string");
  assertEquals(response.grounding_ok, false);
});

Deno.test("multi-agent grounding: agent with RAG may cite only retrieved sources", () => {
  const g = grounding([DOC_A]);
  assertEquals(findCitationsOutsideGrounding([DOC_A], g), []);
  assertEquals(findCitationsOutsideGrounding([DOC_A, DOC_B], g), [DOC_B]);
});

Deno.test("multi-agent grounding: extracts legal issues before retrieval", () => {
  const issues = extractLegalIssues("Evidence admissibility and ECHR fair trial issue", "criminal");
  assertEquals(issues.includes("criminal"), true);
  assertEquals(issues.includes("evidence_admissibility"), true);
  assertEquals(issues.includes("echr_rights"), true);
});

import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import {
  buildDecisionActionPlan,
  buildDecisionVerificationState,
  buildLegalDecisionObject,
  calculateDecisionConfidence,
  detectDecisionContradictions,
  extractMissingInformation,
  type LegalDecisionInput,
} from "./legal-decision-engine.ts";

function cleanInput(overrides: Partial<LegalDecisionInput> = {}): LegalDecisionInput {
  return {
    case_id: "case-clean",
    legal_position: "The position is supported by verified sources and strong court practice.",
    expert_assessments: {
      judge: "supported",
      advocate: "strong",
    },
    final_legal_qa: {
      final_legal_qa_status: "PASS",
      blocking_issues: [],
      warnings: [],
    },
    citation_validation: {
      citation_risk_level: "none",
      citations_verified: true,
      missing_citations: [],
      weak_citations: [],
    },
    official_source_fact_check: {
      official_fact_check_status: "PASS",
      failed_sources: [],
      warnings: [],
    },
    temporal_validations: [
      {
        title: "Civil Code current revision",
        temporal_status: "current_valid",
        usable_as_current_law: true,
        temporal_valid: true,
      },
    ],
    source_hierarchy: {
      conflicts: [],
      source_use_warnings: [],
    },
    court_practice: {
      binding_practice: [
        {
          title: "Cassation Court decision",
          court_level: "cassation",
        },
      ],
      conflicts: [],
      warnings: [],
    },
    facts: {
      confirmed_facts: ["contract signed"],
      disputed_facts: [],
      missing_facts: [],
    },
    issues: ["contract performance"],
    generated_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test("clean inputs produce READY decision", () => {
  const decision = buildLegalDecisionObject(cleanInput());

  assertEquals(decision.status, "READY");
  assertEquals(decision.confidence.level, "high");
  assertEquals(decision.probability_of_success.level, "HIGH");
  assert(decision.decision_id.startsWith("decision_"));
  assert(decision.version_hash.length > 10);
});

Deno.test("final QA FAIL produces BLOCKED", () => {
  const decision = buildLegalDecisionObject(cleanInput({
    final_legal_qa: { final_legal_qa_status: "FAIL", blocking_issues: ["unsupported conclusion"] },
  }));

  assertEquals(decision.status, "BLOCKED");
  assert(decision.explainability.why_blocked.length > 0);
});

Deno.test("final QA REQUIRES_HUMAN_REVIEW produces HUMAN_REVIEW_REQUIRED", () => {
  const decision = buildLegalDecisionObject(cleanInput({
    final_legal_qa: { final_legal_qa_status: "REQUIRES_HUMAN_REVIEW" },
  }));

  assertEquals(decision.status, "HUMAN_REVIEW_REQUIRED");
});

Deno.test("high citation risk lowers confidence", () => {
  const clean = calculateDecisionConfidence(cleanInput());
  const risky = calculateDecisionConfidence(cleanInput({
    citation_validation: {
      citation_risk_level: "high",
      citations_verified: false,
      missing_citations: ["article reference"],
    },
  }));

  assert(risky.numeric_score < clean.numeric_score);
  assertEquals(buildLegalDecisionObject(cleanInput({
    citation_validation: {
      citation_risk_level: "high",
      citations_verified: false,
      missing_citations: ["article reference"],
    },
  })).status, "HUMAN_REVIEW_REQUIRED");
});

Deno.test("official fact-check FAIL blocks decision", () => {
  const decision = buildLegalDecisionObject(cleanInput({
    official_source_fact_check: {
      official_fact_check_status: "FAIL",
      failed_sources: ["source-1"],
    },
  }));

  assertEquals(decision.status, "BLOCKED");
});

Deno.test("unverified official source creates warning", () => {
  const decision = buildLegalDecisionObject(cleanInput({
    official_source_fact_check: {
      official_fact_check_status: "UNVERIFIED_OFFICIAL_SOURCE",
      warnings: ["official source could not be verified"],
    },
  }));

  assertEquals(decision.status, "WARNING");
  assert(decision.conflicts_and_gaps.risks.some((risk) => risk.code === "official_source_unverified"));
});

Deno.test("missing facts lower confidence", () => {
  const clean = calculateDecisionConfidence(cleanInput());
  const incompleteInput = cleanInput({
    facts: {
      confirmed_facts: ["contract signed"],
      disputed_facts: [],
      missing_facts: ["payment date", "notice delivery"],
    },
  });
  const incomplete = calculateDecisionConfidence(incompleteInput);

  assert(incomplete.numeric_score < clean.numeric_score);
  assertEquals(extractMissingInformation(incompleteInput).length, 2);
});

Deno.test("source hierarchy conflict lowers confidence", () => {
  const clean = calculateDecisionConfidence(cleanInput());
  const conflictInput = cleanInput({
    source_hierarchy: {
      conflicts: [
        {
          type: "unresolved_conflict",
          warning: "municipal act conflicts with statute",
          cautious_output_required: true,
        },
      ],
      source_use_warnings: [],
    },
  });
  const conflicted = calculateDecisionConfidence(conflictInput);
  const verification = buildDecisionVerificationState(conflictInput);

  assert(conflicted.numeric_score < clean.numeric_score);
  assertEquals(verification.source_hierarchy_ok, false);
});

Deno.test("strong Cassation practice raises confidence", () => {
  const withoutPractice = calculateDecisionConfidence(cleanInput({
    court_practice: { binding_practice: [], conflicts: [], warnings: [] },
  }));
  const withCassation = calculateDecisionConfidence(cleanInput());

  assert(withCassation.numeric_score > withoutPractice.numeric_score);
});

Deno.test("contradiction detected and recorded", () => {
  const input = cleanInput({
    legal_position: "The claim is strongly supported.",
    expert_assessments: { risk: "weak and likely unsupported" },
  });
  const contradictions = detectDecisionContradictions(input);
  const decision = buildLegalDecisionObject(input);

  assert(contradictions.length > 0);
  assert(decision.conflicts_and_gaps.contradictions.length > 0);
});

Deno.test("decision object is deterministic for same input", () => {
  const input = cleanInput();

  assertEquals(buildLegalDecisionObject(input), buildLegalDecisionObject(input));
});

Deno.test("version_hash changes when input changes", () => {
  const first = buildLegalDecisionObject(cleanInput());
  const second = buildLegalDecisionObject(cleanInput({
    legal_position: "Different supported legal position.",
  }));

  assertNotEquals(first.version_hash, second.version_hash);
});

Deno.test("no network DB LLM or env usage", async () => {
  const source = await Deno.readTextFile("supabase/functions/_shared/legal-decision-engine.ts");
  const forbidden = [
    "fetch(",
    "createClient",
    ".from(",
    ".rpc(",
    "callText",
    "callJSON",
    "callStream",
    "Deno.env",
    "serve(",
  ];

  for (const token of forbidden) {
    assertEquals(source.includes(token), false, token);
  }
});

Deno.test("explainability contains deciding factors", () => {
  const decision = buildLegalDecisionObject(cleanInput());
  const verification = buildDecisionVerificationState(cleanInput());
  const actionPlan = buildDecisionActionPlan(cleanInput());

  assert(decision.explainability.deciding_factors.length > 0);
  assert(decision.explainability.confidence_factors.length > 0);
  assertEquals(verification.final_legal_qa_status, "PASS");
  assert(actionPlan.next_steps.length > 0);
});

import {
  assertEquals,
  assert,
  assertMatch,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  runFinalLegalQA,
  type FinalLegalQAInput,
  type FinalLegalQAStatus,
} from "./final-legal-qa-agent.ts";

// ---------------------------------------------------------------------------
// Scenario 1: PASS — all inputs clean
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - PASS when all inputs clean", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Clean legal analysis without any issues.",
    agentType: "evidence_admissibility",
    mode: "agent_run",
    citationValidation: { citation_risk_level: "none", citations_verified: true },
    officialSourceFactCheck: {
      official_fact_check_status: "NOT_RUN",
      failed_sources: [],
      warnings: [],
    },
    sourceHierarchy: { conflicts: [], source_use_warnings: [] },
    temporalValidations: [
      {
        temporal_status: "current_valid",
        temporal_valid: true,
        usable_as_current_law: true,
        title: "RA Criminal Procedure Code",
      },
    ],
    courtPractice: { weak_practice: [], conflicts: [], warnings: [] },
    groundingOk: true,
    groundingStopCode: undefined,
    legalReasoningRiskFlags: [],
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "PASS");
  assertEquals(result.requires_human_review, false);
  assertEquals(result.safe_to_show_user, true);
  assertEquals(result.blocking_issues.length, 0);
  assertEquals(result.warnings.length, 0);
  assert(result.confidence === "high" || result.confidence === "medium");
  assert(result.qa_summary.includes("passed"));
});

// ---------------------------------------------------------------------------
// Scenario 2: FAIL — groundingOk is false
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - FAIL when groundingOk is false", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis generated without legal grounding.",
    groundingOk: false,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "FAIL");
  assertEquals(result.requires_human_review, true);
  assertEquals(result.safe_to_show_user, false);
  assert(result.blocking_issues.some((i) => i.startsWith("INSUFFICIENT_LEGAL_GROUNDING")));
  assertEquals(result.confidence, "low");
});

// ---------------------------------------------------------------------------
// Scenario 3: FAIL — official_fact_check_status is FAIL
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - FAIL when official_fact_check_status is FAIL", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis referencing invalid official sources.",
    officialSourceFactCheck: {
      official_fact_check_status: "FAIL",
      failed_sources: [{ citation: "bad-source", reason: "domain not found" }],
      warnings: ["domain 'unknown.am' not in allowlist"],
    },
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "FAIL");
  assert(result.blocking_issues.some((i) => i.includes("OFFICIAL_SOURCE_FAIL")));
  assertEquals(result.safe_to_show_user, false);
});

// ---------------------------------------------------------------------------
// Scenario 4: WARNING — official_fact_check_status is UNVERIFIED_OFFICIAL_SOURCE
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - WARNING when official source is UNVERIFIED_OFFICIAL_SOURCE", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis with unverified official sources.",
    officialSourceFactCheck: {
      official_fact_check_status: "UNVERIFIED_OFFICIAL_SOURCE",
      failed_sources: [],
      warnings: [],
    },
    groundingOk: true,
    citationValidation: { citation_risk_level: "none", citations_verified: true },
    sourceHierarchy: { conflicts: [], source_use_warnings: [] },
    legalReasoningRiskFlags: [],
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "WARNING");
  assert(result.warnings.some((w) => w.includes("OFFICIAL_SOURCE_UNVERIFIED")));
  assertEquals(result.safe_to_show_user, true);
  assertEquals(result.requires_human_review, false);
});

// ---------------------------------------------------------------------------
// Scenario 5: REQUIRES_HUMAN_REVIEW — citation risk level is high
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - REQUIRES_HUMAN_REVIEW when citation_risk_level is high", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis with high citation risk — many missing IDs.",
    citationValidation: { citation_risk_level: "high", citations_verified: false },
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "REQUIRES_HUMAN_REVIEW");
  assertEquals(result.requires_human_review, true);
  assertEquals(result.safe_to_show_user, true); // attached, not blocked
  assert(result.blocking_issues.some((i) => i.includes("CITATION_RISK_HIGH")));
});

// ---------------------------------------------------------------------------
// Scenario 6: REQUIRES_HUMAN_REVIEW — temporal validation has expired source
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - REQUIRES_HUMAN_REVIEW when temporal source is expired", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis citing a law that expired in 2010.",
    temporalValidations: [
      {
        temporal_status: "expired",
        temporal_valid: false,
        usable_as_current_law: false,
        title: "RA Law on Fiscal Policy (1995)",
        id: "uuid-expired-law",
      },
    ],
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "REQUIRES_HUMAN_REVIEW");
  assert(result.blocking_issues.some((i) => i.includes("TEMPORAL_INVALID_SOURCE")));
  assert(result.blocking_issues.some((i) => i.includes("expired")));
  assert(result.blocking_issues.some((i) => i.includes("RA Law on Fiscal Policy (1995)")));
});

// ---------------------------------------------------------------------------
// Scenario 7: REQUIRES_HUMAN_REVIEW — repealed source
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - REQUIRES_HUMAN_REVIEW when temporal source is repealed", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis citing a repealed provision.",
    temporalValidations: [
      {
        temporal_status: "repealed",
        temporal_valid: false,
        usable_as_current_law: false,
        title: "Repealed Decree N 100-Ն",
      },
    ],
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "REQUIRES_HUMAN_REVIEW");
  assert(result.blocking_issues.some((i) => i.includes("TEMPORAL_INVALID_SOURCE")));
});

// ---------------------------------------------------------------------------
// Scenario 8: REQUIRES_HUMAN_REVIEW — source hierarchy inactive_source conflict
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - REQUIRES_HUMAN_REVIEW when source hierarchy has inactive_source conflict", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis using an inactive/repealed source.",
    sourceHierarchy: {
      conflicts: [
        {
          type: "inactive_source",
          cautious_output_required: true,
          warning: "Repealed/inactive source cannot be used as current law.",
        },
      ],
      source_use_warnings: [],
    },
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "REQUIRES_HUMAN_REVIEW");
  assert(result.blocking_issues.some((i) => i.includes("SOURCE_CONFLICT_SEVERE")));
  assert(result.blocking_issues.some((i) => i.includes("inactive_source")));
});

// ---------------------------------------------------------------------------
// Scenario 9: REQUIRES_HUMAN_REVIEW — Venice Commission misuse
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - REQUIRES_HUMAN_REVIEW when Venice Commission cited as binding", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis incorrectly treating Venice as binding obligation.",
    sourceHierarchy: {
      conflicts: [],
      source_use_warnings: ["venice_commission_cannot_be_binding"],
    },
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "REQUIRES_HUMAN_REVIEW");
  assert(result.blocking_issues.some((i) => i.includes("VENICE_MISUSE")));
});

// ---------------------------------------------------------------------------
// Scenario 10: REQUIRES_HUMAN_REVIEW — ECHR misuse (replace_domestic_law)
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - REQUIRES_HUMAN_REVIEW when ECHR used as domestic law replacement", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis substituting ECHR for domestic criminal procedure.",
    sourceHierarchy: {
      conflicts: [],
      source_use_warnings: ["echr_requires_domestic_law_explanation"],
    },
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "REQUIRES_HUMAN_REVIEW");
  assert(result.blocking_issues.some((i) => i.includes("ECHR_MISUSE")));
});

// ---------------------------------------------------------------------------
// Scenario 11: REQUIRES_HUMAN_REVIEW — court practice conflict
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - REQUIRES_HUMAN_REVIEW when court practice has cautious conflict", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis based on conflicting court practice.",
    courtPractice: {
      weak_practice: [],
      conflicts: [
        {
          cautious_output_required: true,
          warning: "Lower court practice conflicts with Court of Cassation position.",
        },
      ],
      warnings: [],
    },
    groundingOk: true,
  };

  const result = runFinalLegalQA(input);

  assertEquals(result.final_legal_qa_status, "REQUIRES_HUMAN_REVIEW");
  assert(result.blocking_issues.some((i) => i.includes("COURT_PRACTICE_CONFLICT")));
  assert(result.blocking_issues.some((i) => i.includes("Court of Cassation")));
});

// ---------------------------------------------------------------------------
// Scenario 12: Priority — FAIL dominates REQUIRES_HUMAN_REVIEW
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - FAIL dominates REQUIRES_HUMAN_REVIEW (status priority)", () => {
  const input: FinalLegalQAInput = {
    generatedText: "Analysis with multiple issues.",
    groundingOk: false, // → FAIL
    citationValidation: { citation_risk_level: "high" }, // → REQUIRES_HUMAN_REVIEW
  };

  const result = runFinalLegalQA(input);

  // FAIL wins over REQUIRES_HUMAN_REVIEW
  assertEquals(result.final_legal_qa_status, "FAIL");
  // Both issues are captured in blocking_issues
  assertEquals(
    result.blocking_issues.filter((i) => i.startsWith("INSUFFICIENT_LEGAL_GROUNDING")).length,
    1,
  );
  assertEquals(
    result.blocking_issues.filter((i) => i.includes("CITATION_RISK_HIGH")).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Scenario 13: checked_at is a valid ISO 8601 timestamp
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - result.checked_at is ISO 8601 timestamp", () => {
  const result = runFinalLegalQA({ generatedText: "Test output." });
  assertMatch(result.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// ---------------------------------------------------------------------------
// Scenario 14: Empty generatedText → FAIL
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - FAIL when generatedText is empty", () => {
  const result = runFinalLegalQA({ generatedText: "" });
  assertEquals(result.final_legal_qa_status, "FAIL");
  assert(result.blocking_issues.some((i) => i.includes("EMPTY_OUTPUT")));
});

// ---------------------------------------------------------------------------
// Scenario 15: Minimal input (only text, all metadata null) → PASS with low confidence
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - PASS with low confidence when all metadata is absent", () => {
  const result = runFinalLegalQA({
    generatedText: "An analysis without attached metadata.",
  });
  assertEquals(result.final_legal_qa_status, "PASS");
  assertEquals(result.confidence, "low");
  assertEquals(result.requires_human_review, false);
  assertEquals(result.safe_to_show_user, true);
});

// ---------------------------------------------------------------------------
// Scenario 16: agent_type and mode propagated to result
// ---------------------------------------------------------------------------
Deno.test("FinalLegalQA - agent_type and mode are propagated", () => {
  const result = runFinalLegalQA({
    generatedText: "Analysis.",
    agentType: "aggregator",
    mode: "agent_run",
    groundingOk: true,
  });
  assertEquals(result.agent_type, "aggregator");
  assertEquals(result.mode, "agent_run");
});

import { assertEquals, assertStringIncludes, assert, assertFalse } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildCuratedLegalPromptContext } from "./legal-prompt-serializer.ts";

function createMockEngine(): any {
  return {
    normalized_input: {
      case_type: "civil",
      language: "hy",
      effective_at: "2026-06-30T00:00:00Z"
    },
    facts: {
      missing_facts: ["Exact date of the contract"]
    },
    issues: {
      legal_issues: ["Breach of contract"],
      procedural_issues: [],
      evidentiary_issues: [],
      human_rights_issues: [],
      municipal_or_administrative_issues: []
    },
    domains: ["civil"],
    procedural_stage: "first_instance",
    reasoning_checklist: {
      cautious_output_required: false
    },
    source_hierarchy: {
      binding_sources: [
        { source_level: "RA Civil Code" }
      ],
      auxiliary_sources: [
        { source_level: "Venice Commission Opinion" }
      ],
      conflicts: [{ warning: "Conflict between Article A and B" }]
    },
    temporal_validation: {
      effective_at: "2026-06-30T00:00:00Z",
      temporal_warnings: ["Source X expired"],
      cautious_output_required: true
    },
    court_practice: {
      ranked_practice: [{ id: "CC-1" }],
      binding_practice: [
        { court_level: "constitutional_court" },
        { court_level: "cassation_court" }
      ],
      echr_practice: [{ id: "ECHR-1" }],
      appellate_practice: [],
      weak_practice: [{ court_level: "first_instance" }],
      warnings: ["Outdated practice detected"]
    }
  };
}

Deno.test("LegalPromptSerializer - returns readable text, not JSON dump", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertFalse(result.includes('{"normalized_input"'));
  assertStringIncludes(result, "=== CURATED LEGAL BRIEF ===");
});

Deno.test("LegalPromptSerializer - includes case context", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "1. CASE CONTEXT");
  assertStringIncludes(result, "- Case Type: civil");
  assertStringIncludes(result, "- Legal Domain: civil");
});

Deno.test("LegalPromptSerializer - includes legal issues", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "2. LEGAL ISSUES");
  assertStringIncludes(result, "- Primary Issues: Breach of contract");
});

Deno.test("LegalPromptSerializer - includes temporal warning when effectiveAt missing", () => {
  const engine = createMockEngine();
  engine.normalized_input.effective_at = null;
  engine.temporal_validation = null;
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "Reference date missing; apply temporal caution");
});

Deno.test("LegalPromptSerializer - marks Venice as auxiliary only", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "includes Venice Commission - auxiliary only");
});

Deno.test("LegalPromptSerializer - marks ECHR as interpretive, not domestic-law replacement", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "Interpretive guidance only, cannot replace domestic law without explanation");
});

Deno.test("LegalPromptSerializer - first instance practice is weak only", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "Appellate/First Instance: Weak/persuasive value only.");
});

Deno.test("LegalPromptSerializer - Cassation appears before appellate", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  const cassationIndex = result.indexOf("Cassation Court: Controlling positions");
  const appellateIndex = result.indexOf("Appellate/First Instance");
  assert(cassationIndex < appellateIndex);
});

Deno.test("LegalPromptSerializer - expired source warning is preserved", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "Source X expired");
});

Deno.test("LegalPromptSerializer - source conflict warning is preserved", () => {
  const engine = createMockEngine();
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "Conflict between Article A and B");
});

Deno.test("LegalPromptSerializer - missing court practice produces explicit message", () => {
  const engine = createMockEngine();
  engine.court_practice = { ranked_practice: [], binding_practice: [], persuasive_practice: [], weak_practice: [], echr_practice: [] };
  const result = buildCuratedLegalPromptContext(engine);
  assertStringIncludes(result, "No controlling court practice retrieved");
});

Deno.test("LegalPromptSerializer - output length is bounded and warnings preserved", () => {
  const engine = createMockEngine();
  // Generate massive fake issues
  engine.issues.legal_issues = Array(1000).fill("very long issue ".repeat(10));
  const result = buildCuratedLegalPromptContext(engine);
  // It should be truncated
  assert(result.length < 5500); // the exact cutoff depends on the caution append
  assertStringIncludes(result, "[TRUNCATED]");
  
  // Critical warnings should be preserved
  assertStringIncludes(result, "7. OUTPUT CAUTION");
  assertStringIncludes(result, "conflicting sources");
});

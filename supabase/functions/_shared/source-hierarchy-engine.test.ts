import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  applyLexPosterior,
  applyLexSpecialis,
  buildSourceHierarchyContext,
  classifyLegalSource,
  detectSourceConflicts,
  rankLegalSources,
  validateSourceUse,
} from "./source-hierarchy-engine.ts";

Deno.test("Constitution ranks above statute", () => {
  const ranked = rankLegalSources([
    { id: "law", title: "RA Law on Test" },
    { id: "const", title: "Constitution of the Republic of Armenia" },
  ]);
  assertEquals(ranked[0].source_level, "constitution");
  assertEquals(ranked[1].source_level, "statute");
});

Deno.test("statute ranks above government decision", () => {
  const ranked = rankLegalSources([
    { title: "RA Government Decision N 1" },
    { title: "RA Law on Administrative Procedure" },
  ]);
  assertEquals(ranked[0].source_level, "statute");
  assertEquals(ranked[1].source_level, "government_decision");
});

Deno.test("government decision ranks above municipal act", () => {
  const ranked = rankLegalSources([
    { title: "Yerevan municipality mayor decision" },
    { title: "RA Government Decision N 2" },
  ]);
  assertEquals(ranked[0].source_level, "government_decision");
  assertEquals(ranked[1].source_level, "municipal_act");
});

Deno.test("Cassation ranks above lower court practice", () => {
  const ranked = rankLegalSources([
    { title: "First instance court judgment" },
    { title: "Court of Cassation decision" },
  ]);
  assertEquals(ranked[0].source_level, "cassation_court");
  assertEquals(ranked[1].source_level, "lower_court_practice");
});

Deno.test("Venice Commission is auxiliary only", () => {
  const source = classifyLegalSource({ title: "Venice Commission opinion on constitutional reform" });
  assertEquals(source.source_level, "venice_commission");
  assertEquals(source.binding_status, "auxiliary");
  assert(validateSourceUse(source, "binding_law").warnings.includes("venice_commission_cannot_be_binding"));
});

Deno.test("ECHR requires domestic-law explanation", () => {
  const source = classifyLegalSource({ title: "ECHR case judgment on fair trial" });
  const validation = validateSourceUse(source, "binding_law");
  assertEquals(source.source_level, "ecthr_case_law");
  assert(validation.warnings.includes("echr_requires_domestic_law_explanation"));
});

Deno.test("repealed source cannot be used as current law", () => {
  const validation = validateSourceUse({ title: "RA Law on Old Matter", norm_status: "repealed" }, "current_law");
  assert(validation.warnings.includes("inactive_source_cannot_be_current_law"));
});

Deno.test("lex specialis beats general norm", () => {
  const result = applyLexSpecialis([
    { id: "general", title: "General civil code rule on contracts", category: "code" },
    { id: "special", title: "Special consumer contract rule", category: "code" },
  ], ["consumer contract"]);
  assertEquals(result[0].general_rule?.id, "general");
  assertEquals(result[0].special_rule?.id, "special");
  assertEquals(result[0].whether_special_rule_controls, true);
});

Deno.test("lex posterior beats older same-level norm", () => {
  const result = applyLexPosterior([
    { id: "old", title: "RA Law on Test", adopted_at: "2020-01-01" },
    { id: "new", title: "RA Law on Test amendment", adopted_at: "2024-01-01", norm_status: "active" },
  ]);
  assertEquals(result[0].older_rule?.id, "old");
  assertEquals(result[0].later_rule?.id, "new");
  assertEquals(result[0].whether_later_rule_controls, true);
});

Deno.test("municipal act conflict with statute produces warning", () => {
  const conflicts = detectSourceConflicts([
    { id: "statute", title: "RA Law on Local Self-Government" },
    { id: "municipal", title: "Municipality mayor decision" },
  ]);
  assert(conflicts.some((c) => c.type === "municipal_conflict_with_higher_law"));
});

Deno.test("lower court conflict with Cassation produces warning", () => {
  const conflicts = detectSourceConflicts([
    { id: "cass", title: "Court of Cassation decision" },
    { id: "lower", title: "First instance court judgment" },
  ]);
  assert(conflicts.some((c) => c.type === "lower_court_conflict_with_cassation"));
});

Deno.test("unknown source gets low confidence and cautious warning", () => {
  const context = buildSourceHierarchyContext([{ id: "unknown", title: "Unlabeled source" }]);
  assertEquals(context.ranked_sources[0].source_level, "unknown");
  assertEquals(context.ranked_sources[0].confidence, "low");
  assert(context.source_use_warnings.includes("unknown_source_low_confidence"));
});

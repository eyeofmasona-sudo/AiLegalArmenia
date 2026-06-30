import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  classifyCourtPractice,
  rankCourtPractice,
  linkPracticeToNorms,
  detectPracticeConflicts,
  detectCassationPosition,
  detectConstitutionalCourtPosition,
  buildCourtPracticeContext,
  validatePracticeUse,
  type PracticeSourceLike,
} from "./court-practice-engine.ts";

const cc: PracticeSourceLike = {
  id: "cc1", court_type: "constitutional_court", title: "ՍԴ որոշում",
  legal_issue: "constitutional review of statute", applied_articles: ["6"],
  decision_date: "2022-05-01",
};
const cassation: PracticeSourceLike = {
  id: "cas1", court_type: "cassation_court", title: "Վճռաբեկ դատարանի որոշում",
  legal_issue: "interpretation of article 8", applied_articles: ["8"],
  decision_date: "2021-03-01",
};
const appellate: PracticeSourceLike = {
  id: "app1", court_type: "appellate_court", title: "Վերաքննիչ դատարան",
  legal_issue: "interpretation of article 8", applied_articles: ["8"],
  decision_date: "2020-01-01",
};
const firstInstance: PracticeSourceLike = {
  id: "fi1", court_type: "first_instance_court", title: "Առաջին ատյանի դատարան",
  applied_articles: ["8"], decision_date: "2019-01-01",
};
const echr: PracticeSourceLike = {
  id: "echr1", practice_category: "echr", court_type: "echr",
  title: "ECHR judgment", legal_issue: "Article 6 fair trial", decision_date: "2018-06-01",
};
const venice: PracticeSourceLike = {
  id: "ven1", title: "Venice Commission opinion on judicial reform",
};

// 1. Constitutional Court ranks above Cassation on a constitutional issue.
Deno.test("Constitutional Court ranks above Cassation on constitutional issue", () => {
  const ranked = rankCourtPractice([cassation, cc], { constitutional_issue: true });
  assertEquals(ranked[0].court_level, "constitutional_court");
  assertEquals(ranked[0].authority_weight > ranked[1].authority_weight, true);
});

// 2. Cassation ranks above appellate.
Deno.test("Cassation ranks above appellate", () => {
  const ranked = rankCourtPractice([appellate, cassation]);
  assertEquals(ranked[0].court_level, "cassation_court");
  assertEquals(ranked[1].court_level, "appellate_court");
});

// 3. Appellate cannot override Cassation.
Deno.test("Appellate cannot override Cassation", () => {
  const r = validatePracticeUse(appellate, "override_cassation");
  assertEquals(r.allowed, false);
  assertEquals(r.warnings.includes("appellate_cannot_override_cassation"), true);
});

// 4. First instance is weak persuasive only.
Deno.test("First instance is weak persuasive only", () => {
  const c = classifyCourtPractice(firstInstance);
  assertEquals(c.weight_class, "weak");
  assertEquals(c.binding, false);
  assertEquals(c.persuasive, true);
});

// 5. ECHR triggers human-rights context.
Deno.test("ECHR triggers human-rights context", () => {
  const ctx = buildCourtPracticeContext([echr], { issues: { human_rights_issues: ["Art 6"] } });
  assertEquals(ctx.echr_practice.length, 1);
  assertEquals(ctx.echr_practice[0].requires_domestic_link, true);
  assertEquals(ctx.warnings.includes("echr_requires_domestic_link"), true);
});

// 6. ECHR cannot replace domestic law without explanation.
Deno.test("ECHR cannot replace domestic law without explanation", () => {
  const r = validatePracticeUse(echr, "replace_domestic_law");
  assertEquals(r.allowed, false);
  assertEquals(r.requires_explanation, true);
  assertEquals(r.warnings.includes("echr_cannot_replace_domestic_law_without_explanation"), true);
});

// 7. Venice is not court practice.
Deno.test("Venice is not court practice", () => {
  const c = classifyCourtPractice(venice);
  assertEquals(c.is_court_practice, false);
  assertEquals(c.weight_class, "auxiliary");
  const r = validatePracticeUse(venice, "binding_precedent");
  assertEquals(r.allowed, false);
});

// 8. Outdated practice creates warning.
Deno.test("outdated practice creates warning", () => {
  const outdated: PracticeSourceLike = { ...cassation, id: "cas_old", norm_status: "repealed" };
  const c = classifyCourtPractice(outdated);
  assertEquals(c.outdated, true);
  assertEquals(c.warnings.includes("practice_outdated_or_superseded"), true);
});

// 9. Conflicting Cassation/appellate creates warning.
Deno.test("conflicting Cassation/appellate creates warning", () => {
  const conflicts = detectPracticeConflicts([cassation, appellate]);
  const hv = conflicts.find((c) => c.type === "higher_vs_lower");
  assertEquals(Boolean(hv), true);
  assertEquals(hv!.higher!.court_level, "cassation_court");
  assertEquals(hv!.lower!.court_level, "appellate_court");
  assertEquals(hv!.lower!.conflicting_with_higher_practice, true);
});

// 10. Practice can be linked to norm by article/reference.
Deno.test("practice can be linked to norm by article/reference", () => {
  const links = linkPracticeToNorms([cassation], [
    { id: "n8", article_number: "8", title: "Civil Code art. 8" },
    { id: "n99", article_number: "99", title: "unrelated" },
  ]);
  assertEquals(links.length, 1);
  assertEquals(links[0].practice_id, "cas1");
  assertEquals(links[0].matched_norm_ids, ["n8"]);
});

// 11. Distinguishable facts create caution.
Deno.test("distinguishable facts create caution", () => {
  const distinguishablePractice: PracticeSourceLike = { ...cassation, id: "cas_dist", similarity: 0.3 };
  const c = classifyCourtPractice(distinguishablePractice);
  assertEquals(c.distinguishable, true);
  const r = validatePracticeUse(c, "persuasive_support");
  assertEquals(r.requires_explanation, true);
  assertEquals(r.warnings.includes("facts_distinguishable_requires_explanation"), true);
});

// 12. Document generation cannot treat first instance as binding.
Deno.test("document generation cannot treat first instance as binding", () => {
  const r = validatePracticeUse(firstInstance, "document_generation_binding");
  assertEquals(r.allowed, false);
  assertEquals(r.warnings.includes("first_instance_cannot_be_binding_precedent"), true);
});

// Bonus: detectCassationPosition / detectConstitutionalCourtPosition
Deno.test("detect controlling Cassation and Constitutional positions", () => {
  const cas = detectCassationPosition([cassation, appellate, cc]);
  assertEquals(cas.length, 1);
  assertEquals(cas[0].id, "cas1");
  const con = detectConstitutionalCourtPosition([cassation, cc]);
  assertEquals(con.length, 1);
  assertEquals(con[0].id, "cc1");
});

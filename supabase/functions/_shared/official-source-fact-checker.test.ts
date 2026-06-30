import { assertEquals, assert, assertArrayIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { 
  OFFICIAL_SOURCE_ALLOWLIST, 
  extractOfficialCheckTargets, 
  runOfficialSourceFactCheckStub 
} from "./official-source-fact-checker.ts";

Deno.test("OfficialSourceFactChecker - allowlist contains only official domains", () => {
  const allowed = [...OFFICIAL_SOURCE_ALLOWLIST];
  assertArrayIncludes(allowed, ["arlis.am", "court.am", "concourt.am", "datalex.am", "gov.am", "e-gov.am", "yerevan.am", "echr.coe.int", "hudoc.echr.coe.int", "venice.coe.int"]);
  assertEquals(allowed.length, 10);
});

Deno.test("OfficialSourceFactChecker - extracts ARLIS legal act target", () => {
  const text = "According to ՀՕ-123 and N 45-Ն, the law states...";
  const targets = extractOfficialCheckTargets(text, []);
  
  const acts = targets.filter(t => t.type === "act");
  assertEquals(acts.length, 2);
  assertEquals(acts[0].raw_text, "ՀՕ-123");
  assertEquals(acts[0].expected_domain, "arlis.am");
  assertEquals(acts[1].raw_text, "N 45-Ն");
});

Deno.test("OfficialSourceFactChecker - extracts Cassation/court case target", () => {
  const text = "The court ruled in ԵԴ/1234/02 and then in ՍնԴ/0011/04.";
  const targets = extractOfficialCheckTargets(text, []);
  
  const cases = targets.filter(t => t.type === "case_number");
  assertEquals(cases.length, 2);
  assertEquals(cases[0].raw_text, "ԵԴ/1234/02");
  assertEquals(cases[0].expected_domain, "datalex.am");
});

Deno.test("OfficialSourceFactChecker - extracts ECHR/HUDOC target", () => {
  const text = "As stated by the ՄԻԵԴ in its recent judgment";
  const targets = extractOfficialCheckTargets(text, []);
  
  const echr = targets.find(t => t.expected_domain === "hudoc.echr.coe.int");
  assert(echr);
  assertEquals(echr.raw_text, "ECHR reference");
});

Deno.test("OfficialSourceFactChecker - extracts Venice target", () => {
  const text = "The Վենետիկի հանձնաժողով concluded that";
  const targets = extractOfficialCheckTargets(text, []);
  
  const venice = targets.find(t => t.expected_domain === "venice.coe.int");
  assert(venice);
  assertEquals(venice.raw_text, "Venice Commission Document");
});

Deno.test("OfficialSourceFactChecker - unknown source creates warning", () => {
  // A URL not in the allowlist
  const text = "See https://example.com/law for details.";
  const result = runOfficialSourceFactCheckStub({ analysisText: text, citations: [] });
  
  assert(result.warnings.some(w => w.includes("not in the official allowlist")));
  assertEquals(result.official_fact_check_status, "UNVERIFIED_OFFICIAL_SOURCE");
});

Deno.test("OfficialSourceFactChecker - stub never marks source as verified", () => {
  const text = "Valid case ԵԴ/1234/02";
  const result = runOfficialSourceFactCheckStub({ analysisText: text, citations: [] });
  
  assertEquals(result.checked_sources.length, 1);
  assertEquals(result.checked_sources[0].status, "unverified");
});

Deno.test("OfficialSourceFactChecker - targets produce UNVERIFIED_OFFICIAL_SOURCE", () => {
  const text = "ՀՕ-123 is the applicable law.";
  const result = runOfficialSourceFactCheckStub({ analysisText: text, citations: [] });
  
  assertEquals(result.official_fact_check_status, "UNVERIFIED_OFFICIAL_SOURCE");
  assertEquals(result.targets.length, 1);
});

Deno.test("OfficialSourceFactChecker - no targets produce NOT_RUN", () => {
  const text = "This is a general legal opinion without specific citations.";
  const result = runOfficialSourceFactCheckStub({ analysisText: text, citations: [] });
  
  assertEquals(result.official_fact_check_status, "NOT_RUN");
  assertEquals(result.targets.length, 0);
  assertEquals(result.checked_sources.length, 0);
});

Deno.test("OfficialSourceFactChecker - requires_human_review true when failed_sources or must_not_use exist", () => {
  const text = "Just some text with a target: ԵԴ/1234/02";
  const input = { analysisText: text, citations: [], metadata: { force_fail_test: true } };
  
  const result = runOfficialSourceFactCheckStub(input);
  
  assert(result.requires_human_review === true);
  assertEquals(result.failed_sources.length, 1);
});

Deno.test("OfficialSourceFactChecker - aggregator output includes official_source_fact_check metadata and warning", () => {
  const text = "Just some text with a target: ԵԴ/1234/02";
  const input = { analysisText: text, citations: [], metadata: { agentType: "aggregator" } };
  
  const result = runOfficialSourceFactCheckStub(input);
  
  assertEquals(result.official_fact_check_status, "UNVERIFIED_OFFICIAL_SOURCE");
  assert(result.warnings.some(w => w.includes("Aggregator cannot alter official fact-check status")));
});

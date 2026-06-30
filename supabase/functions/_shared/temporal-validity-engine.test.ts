import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  applyTemporalValidation,
  buildTemporalContextForPrompt,
  buildTemporalFilter,
  buildTemporalWarnings,
  classifyTemporalStatus,
  normalizeEffectiveDate,
  requireTemporalCaution,
  validateTemporalSource,
} from "./temporal-validity-engine.ts";

Deno.test("normalizeEffectiveDate supports ISO, dotted, Date and invalid", () => {
  assertEquals(normalizeEffectiveDate("2025-03-04T10:00:00Z"), "2025-03-04");
  assertEquals(normalizeEffectiveDate("04.03.2025"), "2025-03-04");
  assertEquals(normalizeEffectiveDate(new Date("2025-03-04T00:00:00Z")), "2025-03-04");
  assertEquals(normalizeEffectiveDate("not a date"), null);
});

Deno.test("buildTemporalFilter emits required SQL guard", () => {
  const filter = buildTemporalFilter("2025-01-01");
  assert(filter.sql.includes("(norm_status IS NULL OR norm_status = 'active')"));
  assert(filter.sql.includes("effective_from <= p_effective_at"));
  assert(filter.sql.includes("effective_to > p_effective_at"));
});

Deno.test("missing reference date creates warning", () => {
  const source = validateTemporalSource({ title: "Current law", effective_from: "2020-01-01" }, null);
  assertEquals(source.temporal_status, "missing_reference_date");
  assert(source.temporal_warnings.includes("effective_date_missing"));
});

Deno.test("not yet effective source is invalid for reference date", () => {
  const source = validateTemporalSource({ effective_from: "2026-01-01", norm_status: "active" }, "2025-01-01");
  assertEquals(source.temporal_status, "not_yet_effective");
  assertEquals(source.temporal_valid, false);
});

Deno.test("expired source is invalid for current reference date", () => {
  const source = validateTemporalSource({ effective_from: "2020-01-01", effective_to: "2024-01-01", norm_status: "active" }, "2025-01-01");
  assertEquals(source.temporal_status, "expired");
  assertEquals(source.usable_as_current_law, false);
});

Deno.test("repealed source cannot be current law", () => {
  assertEquals(classifyTemporalStatus({ norm_status: "repealed" }, "2025-01-01"), "repealed");
});

Deno.test("historical non-current source may be used with historical marker", () => {
  const source = validateTemporalSource({
    effective_from: "2010-01-01",
    effective_to: "2020-01-01",
    norm_status: "active",
    is_current: false,
  }, "2015-01-01");
  assertEquals(source.temporal_status, "historically_valid");
  assertEquals(source.historical_revision, true);
});

Deno.test("unknown effective date stays usable but warned", () => {
  const source = validateTemporalSource({ norm_status: "active" }, "2025-01-01");
  assertEquals(source.temporal_status, "unknown_effective_date");
  assert(source.temporal_warnings.includes("source_effective_date_unknown"));
});

Deno.test("conflicting revisions are detected", () => {
  const sources = applyTemporalValidation([
    { document_id: "doc-a", chunk_id: "old", effective_from: "2020-01-01", norm_status: "active" },
    { document_id: "doc-a", chunk_id: "new", effective_from: "2021-01-01", norm_status: "active" },
  ], "2022-01-01");
  assertEquals(sources[0].temporal_status, "conflicting_revision");
  assertEquals(sources[1].temporal_status, "conflicting_revision");
});

Deno.test("buildTemporalWarnings aggregates source warnings", () => {
  const warnings = buildTemporalWarnings([
    { effective_from: "2026-01-01", norm_status: "active" },
    { norm_status: "repealed" },
  ], "2025-01-01");
  assert(warnings.includes("source_not_yet_effective_for_reference_date"));
  assert(warnings.includes("source_repealed_or_inactive"));
});

Deno.test("requireTemporalCaution true when event date missing", () => {
  assertEquals(requireTemporalCaution({ normalized_input: { effective_at: null } }, []), true);
});

Deno.test("buildTemporalContextForPrompt contains validated sources and caution", () => {
  const context = buildTemporalContextForPrompt(
    { normalized_input: { effective_at: "2025-01-01" } },
    [{ title: "Future law", effective_from: "2026-01-01", norm_status: "active" }],
  );
  assertEquals(context.cautious_output_required, true);
  assertEquals(context.validated_sources[0].temporal_status, "not_yet_effective");
});

Deno.test("RPC migration applies identical temporal predicate in retrieval arms", async () => {
  const sql = await Deno.readTextFile("supabase/migrations/20260630120000_harden_temporal_validity_all_retrieval_paths.sql");
  for (const cte of ["metric_candidates", "qwen_candidates", "bm25_candidates"]) {
    assert(sql.includes(`${cte} as (`), `${cte} must exist`);
  }
  const required = [
    "(sc.norm_status is null or sc.norm_status = 'active'::public.normalized_status)",
    "(p_effective_at is null or sc.effective_from is null or sc.effective_from <= p_effective_at)",
    "(p_effective_at is null or sc.effective_to is null or sc.effective_to > p_effective_at)",
    "(p_effective_at is not null or dv.is_current = true)",
  ];
  for (const predicate of required) {
    assert(sql.includes(predicate), `missing predicate: ${predicate}`);
  }
});

Deno.test("vector-search forwards normalized effective date to RPC", async () => {
  const text = await Deno.readTextFile("supabase/functions/vector-search/index.ts");
  assert(text.includes("normalizeEffectiveDate(reference_date)"));
  assert(text.includes("p_effective_at: normalizedReferenceDate"));
  assert(text.includes("temporal_warnings"));
});

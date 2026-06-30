import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  extractCitedIds,
  extractCitationClaims,
  verifyAgainstAllowlist,
  verifyAgainstDb,
  shouldReject,
} from "./citation-verifier.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-9222-222222222222";
const C = "33333333-3333-4333-a333-333333333333";

Deno.test("extractCitedIds(markers): only UUIDs after ID marker", () => {
  const text = `See ID:${A}. Random uuid ${B} not cited.`;
  assertEquals(extractCitedIds(text, "markers"), [A]);
});

Deno.test("extractCitedIds(markers): multiple IDs in one marker group", () => {
  const text = `ID: ${A}, ${B}; narrative ${C}`;
  assertEquals(extractCitedIds(text, "markers").sort(), [A, B].sort());
});

Deno.test("extractCitedIds(any): every UUID in JSON", () => {
  const json = JSON.stringify({ refs: [A, B], note: `inline ${C}` });
  assertEquals(extractCitedIds(json, "any").sort(), [A, B, C].sort());
});

Deno.test("extractCitationClaims: document and chunk markers", () => {
  const text = `Quote "important legal phrase" (ID:${A}, ChunkID:${B})`;
  const claims = extractCitationClaims(text, "markers");
  assertEquals(claims.length, 1);
  assertEquals(claims[0].document_id, A);
  assertEquals(claims[0].chunk_id, B);
  assertEquals(claims[0].quoted_text, "important legal phrase");
});

Deno.test("allowlist: all cited present", () => {
  const r = verifyAgainstAllowlist([A, B], [A, B, C]);
  assertEquals(r.citations_verified, true);
  assertEquals(r.reason, "ok");
  assertEquals(r.cited_ids_count, 2);
});

Deno.test("allowlist: cited outside registry", () => {
  const r = verifyAgainstAllowlist([A, C], [A, B]);
  assertEquals(r.citations_verified, false);
  assertEquals(r.reason, "unverified_ids");
  assertEquals(r.missing_ids, [C]);
});

Deno.test("allowlist: no citations", () => {
  const r = verifyAgainstAllowlist([], [A]);
  assertEquals(r.citations_verified, true);
  assertEquals(r.reason, "no_citations");
});

Deno.test("allowlist: too many citations", () => {
  const many = Array.from({ length: 51 }, (_, i) =>
    `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
  const r = verifyAgainstAllowlist(many, many);
  assertEquals(r.citations_verified, false);
  assertEquals(r.reason, "too_many_citations");
});

Deno.test("allowlist: skipIds ignored", () => {
  const r = verifyAgainstAllowlist([A, B], [A], { skipIds: [B] });
  assertEquals(r.citations_verified, true);
  assertEquals(r.cited_ids_count, 1);
});

function stubSupabase(foundIds: string[], opts: { error?: boolean } = {}) {
  return {
    from: (table: string) => ({
      select: (_cols: string) => ({
        in: (_col: string, vals: string[]) => {
          if (opts.error) return Promise.resolve({ data: null, error: { message: "boom" } });
          if (table === "documents") {
            const requested = new Set(vals.map((v) => v.toLowerCase()));
            return Promise.resolve({
              data: foundIds
                .filter((id) => requested.has(id.toLowerCase()))
                .map((id) => ({
                  document_id: id,
                  title_hy: "Doc",
                  content_domain: "knowledge_base",
                  normalized_status: "active",
                  effective_from: "2024-01-01",
                })),
              error: null,
            });
          }
          if (table === "document_versions") {
            return Promise.resolve({
              data: foundIds.map((id) => ({
                document_id: id,
                published_at: "2024-01-01",
                is_current: true,
              })),
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
      }),
    }),
  };
}

Deno.test("db: document-only citations are weak", async () => {
  const r = await verifyAgainstDb([A, B], stubSupabase([A, B]));
  assertEquals(r.citations_verified, false);
  assertEquals(r.reason, "unverified_ids");
  assertEquals(r.weak_citations.length, 2);
  assertEquals(r.citation_risk_level, "medium");
});

Deno.test("db: missing id", async () => {
  const r = await verifyAgainstDb([A, B], stubSupabase([A]));
  assertEquals(r.citations_verified, false);
  assertEquals(r.missing_ids, [B]);
});

Deno.test("db: query error", async () => {
  const r = await verifyAgainstDb([A], stubSupabase([], { error: true }));
  assertEquals(r.citations_verified, false);
  assertEquals(r.reason, "verification_query_failed");
});

Deno.test("db: no citations", async () => {
  const r = await verifyAgainstDb([], stubSupabase([]));
  assertEquals(r.citations_verified, true);
  assertEquals(r.reason, "no_citations");
});

Deno.test("shouldReject: strict blocks unverified, annotate never blocks", () => {
  const bad = {
    citations_verified: false,
    cited_ids_count: 1,
    reason: "unverified_ids" as const,
    verified_citations: [],
    weak_citations: [],
    missing_citations: [],
    citation_risk_level: "high" as const,
    requires_cautious_language: true,
    forbidden_certainty_phrases: [],
  };
  const ok = { ...bad, citations_verified: true, reason: "ok" as const };
  assertEquals(shouldReject(bad, "strict"), true);
  assertEquals(shouldReject(bad, "annotate"), false);
  assertEquals(shouldReject(ok, "strict"), false);
});

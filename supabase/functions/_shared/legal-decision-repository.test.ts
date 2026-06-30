import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import type { LegalDecisionObject } from "./legal-decision-engine.ts";
import {
  computeDecisionSupersession,
  getLatestLegalDecision,
  listLegalDecisionVersions,
  markPreviousDecisionsNotLatest,
  saveLegalDecisionSnapshot,
  type LegalDecisionRepositoryResult,
  type LegalDecisionRow,
} from "./legal-decision-repository.ts";

const CASE_ID = "11111111-1111-4111-8111-111111111111";

function decision(versionHash: string, status: LegalDecisionObject["status"] = "READY"): LegalDecisionObject {
  return {
    decision_id: `decision_${versionHash}`,
    case_id: CASE_ID,
    version_hash: versionHash,
    status,
    legal_position: `Position ${versionHash}`,
    confidence: { level: "high", numeric_score: 90, reasons: ["test"] },
    probability_of_success: {
      level: "HIGH",
      basis: "rule_based_only",
      disclaimer: "test",
    },
    expert_assessments: {},
    conflicts_and_gaps: {
      risks: [],
      contradictions: [],
      missing_information: [],
    },
    verification_state: {
      final_legal_qa_status: "PASS",
      citation_risk_level: "none",
      citations_verified: true,
      official_fact_check_status: "PASS",
      temporal_validity_ok: true,
      source_hierarchy_ok: true,
      court_practice_strength: "strong",
      warnings: [],
      blocked_reasons: [],
    },
    action_plan: {
      immediate_actions: [],
      evidence_actions: [],
      citation_actions: [],
      review_actions: [],
      next_steps: ["test"],
    },
    explainability: {
      deciding_factors: ["test"],
      confidence_factors: ["test"],
      risk_factors: [],
      why_human_review_required: [],
      why_blocked: [],
    },
    created_at: "2026-06-30T00:00:00.000Z",
  };
}

Deno.test("saves new decision", async () => {
  const client = new MockSupabaseClient();
  const result = await saveLegalDecisionSnapshot(client, decision("hash-a"), {
    sourcePipelineVersion: "2.0.0",
    createdBy: "22222222-2222-4222-8222-222222222222",
  });

  assertEquals(result.error, null);
  assertEquals(result.inserted, true);
  assertEquals(result.duplicate, false);
  assertEquals(client.rows.length, 1);
  assertEquals(result.data?.source_pipeline_version, "2.0.0");
});

Deno.test("duplicate version returns existing", async () => {
  const client = new MockSupabaseClient();
  const first = await saveLegalDecisionSnapshot(client, decision("hash-a"));
  const second = await saveLegalDecisionSnapshot(client, decision("hash-a"));

  assertEquals(first.inserted, true);
  assertEquals(second.inserted, false);
  assertEquals(second.duplicate, true);
  assertEquals(second.data?.id, first.data?.id);
  assertEquals(client.rows.length, 1);
});

Deno.test("new version supersedes previous", async () => {
  const client = new MockSupabaseClient();
  const first = await saveLegalDecisionSnapshot(client, decision("hash-a"));
  const second = await saveLegalDecisionSnapshot(client, decision("hash-b", "WARNING"));

  assertEquals(second.error, null);
  assertEquals(second.data?.supersedes_decision_id, first.data?.id);
  assertEquals(second.superseded_decision_id, first.data?.id);
});

Deno.test("previous latest marked false", async () => {
  const client = new MockSupabaseClient();
  const first = await saveLegalDecisionSnapshot(client, decision("hash-a"));
  const second = await saveLegalDecisionSnapshot(client, decision("hash-b"));

  assertEquals(client.rows.find((row) => row.id === first.data?.id)?.is_latest, false);
  assertEquals(client.rows.find((row) => row.id === second.data?.id)?.is_latest, true);
});

Deno.test("latest query returns newest", async () => {
  const client = new MockSupabaseClient();
  await saveLegalDecisionSnapshot(client, decision("hash-a"));
  const second = await saveLegalDecisionSnapshot(client, decision("hash-b"));

  const latest = await getLatestLegalDecision(client, CASE_ID);

  assertEquals(latest.error, null);
  assertEquals(latest.data?.id, second.data?.id);
});

Deno.test("list versions sorted newest first", async () => {
  const client = new MockSupabaseClient();
  await saveLegalDecisionSnapshot(client, decision("hash-a"));
  await saveLegalDecisionSnapshot(client, decision("hash-b"));

  const versions = await listLegalDecisionVersions(client, CASE_ID);

  assertEquals(versions.error, null);
  assertEquals(versions.data?.map((row) => row.version_hash), ["hash-b", "hash-a"]);
});

Deno.test("repository never mutates decision_data", async () => {
  const client = new MockSupabaseClient();
  const input = decision("hash-a");
  const before = JSON.parse(JSON.stringify(input));

  await saveLegalDecisionSnapshot(client, input);
  client.rows[0].decision_data.legal_position = "mutated stored copy";

  assertEquals(input, before);
});

Deno.test("handles DB error gracefully", async () => {
  const client = new MockSupabaseClient();
  client.failNext = { message: "db unavailable" };

  const result = await saveLegalDecisionSnapshot(client, decision("hash-a"));

  assertEquals(result.data, null);
  assertEquals(result.inserted, false);
  assert(result.error);
});

Deno.test("mocked client supported", async () => {
  const client = new MockSupabaseClient();

  await saveLegalDecisionSnapshot(client, decision("hash-a"));
  await computeDecisionSupersession(client, CASE_ID);
  await markPreviousDecisionsNotLatest(client, CASE_ID);

  assertEquals(client.lastSchema, "app");
  assertEquals(client.lastTable, "legal_decisions");
});

class MockSupabaseClient {
  rows: LegalDecisionRow[] = [];
  /** Causes the next rpc() call to fail before any state change (total failure). */
  failNext: unknown | null = null;
  /** Causes the INSERT inside rpc() to fail after marking previous as not-latest,
   *  then restores the previous state — simulating an atomic Postgres rollback. */
  failInsert: unknown | null = null;
  lastSchema: string | null = null;
  lastTable: string | null = null;
  private nextId = 1;

  schema(schema: string): MockSupabaseClient {
    this.lastSchema = schema;
    return this;
  }

  from(table: string): MockQueryBuilder {
    this.lastTable = table;
    return new MockQueryBuilder(this);
  }

  /**
   * Phase 7.5B: Simulates app.save_legal_decision_atomic.
   *
   * Follows the same ordering as the Postgres function:
   *   0. failNext  → total failure, no state change
   *   1. Duplicate check → return existing row
   *   2. Locate previous latest
   *   3. Mark previous is_latest = false  (UPDATE before INSERT)
   *   4. failInsert → rollback step 3, return error
   *   5. Insert new row with is_latest = true
   */
  async rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<LegalDecisionRepositoryResult<unknown>> {
    if (fn !== "save_legal_decision_atomic") {
      return { data: null, error: { message: `Unknown RPC function: ${fn}` } };
    }

    // Step 0: total failure before any DB work
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return { data: null, error };
    }

    const caseId = args["p_case_id"] as string;
    const versionHash = args["p_version_hash"] as string;

    // Step 1: duplicate check (fast path, no state change)
    const existing = this.rows.find(
      (r) => r.case_id === caseId && r.version_hash === versionHash,
    );
    if (existing) {
      return { data: { _action: "duplicate", ...existing }, error: null };
    }

    // Step 2: find previous latest (advisory lock + SELECT FOR UPDATE in Postgres)
    const previousIdx = this.rows.findIndex(
      (r) => r.case_id === caseId && r.is_latest === true,
    );
    const previousId = previousIdx >= 0 ? this.rows[previousIdx].id : null;

    // Step 3: clear previous latest BEFORE inserting (mirrors Postgres order)
    if (previousIdx >= 0) {
      this.rows[previousIdx].is_latest = false;
    }

    // Step 4: simulate INSERT failure → automatic Postgres rollback
    if (this.failInsert) {
      const error = this.failInsert;
      this.failInsert = null;
      // Restore previous is_latest (transaction rolled back in Postgres)
      if (previousIdx >= 0) {
        this.rows[previousIdx].is_latest = true;
      }
      return { data: null, error };
    }

    // Step 5: insert new snapshot
    const rowNumber = this.nextId++;
    const newRow: LegalDecisionRow = {
      id: `00000000-0000-4000-8000-${String(rowNumber).padStart(12, "0")}`,
      case_id: caseId,
      version_hash: versionHash,
      decision_status: args["p_decision_status"] as LegalDecisionRow["decision_status"],
      decision_data: JSON.parse(JSON.stringify(args["p_decision_data"])),
      source_pipeline_version: (args["p_source_pipeline_version"] as string | null) ?? null,
      created_by: (args["p_created_by"] as string | null) ?? null,
      created_at: `2026-06-30T00:00:0${rowNumber}.000Z`,
      supersedes_decision_id: previousId,
      is_latest: true,
    };
    this.rows.push(newRow);

    return { data: { _action: "inserted", ...newRow }, error: null };
  }

  createRow(values: Record<string, unknown>): LegalDecisionRow {
    const rowNumber = this.nextId++;
    return {
      id: `00000000-0000-4000-8000-${String(rowNumber).padStart(12, "0")}`,
      case_id: values.case_id as string,
      version_hash: values.version_hash as string,
      decision_status: values.decision_status as LegalDecisionRow["decision_status"],
      decision_data: JSON.parse(JSON.stringify(values.decision_data)),
      source_pipeline_version: (values.source_pipeline_version as string | null) ?? null,
      created_by: (values.created_by as string | null) ?? null,
      created_at: `2026-06-30T00:00:0${rowNumber}.000Z`,
      supersedes_decision_id: (values.supersedes_decision_id as string | null) ?? null,
      is_latest: values.is_latest as boolean,
    };
  }
}

class MockQueryBuilder implements PromiseLike<LegalDecisionRepositoryResult<unknown>> {
  private filters: Array<{ column: string; value: unknown }> = [];
  private operation: "select" | "insert" | "update" = "select";
  private insertValues: Record<string, unknown> | null = null;
  private updateValues: Record<string, unknown> | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitCount: number | null = null;

  constructor(private readonly client: MockSupabaseClient) {}

  select(_columns?: string): MockQueryBuilder {
    return this;
  }

  eq(column: string, value: unknown): MockQueryBuilder {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string,
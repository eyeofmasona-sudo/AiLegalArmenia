/**
 * Legal Decision Repository — Phase 7.1 / Phase 7.5B
 *
 * Phase 7.5B: saveLegalDecisionSnapshot replaced with a single RPC call to
 * app.save_legal_decision_atomic (migration 20260630123000).  The Postgres
 * function acquires an advisory lock on the case_id, clears the previous
 * is_latest row, and inserts the new snapshot — all inside one transaction.
 *
 * Atomic guarantee: at most one is_latest = true row exists per case_id at
 * any moment, even under concurrent callers.
 *
 * Public signatures are unchanged from Phase 7.1 so all callers (ai-analyze,
 * tests) continue to work without modification.
 */

import type { LegalDecisionObject, LegalDecisionStatus } from "./legal-decision-engine.ts";

// ── Shared types ──────────────────────────────────────────────────────────────

export interface LegalDecisionRow {
  id: string;
  case_id: string;
  version_hash: string;
  decision_status: LegalDecisionStatus;
  decision_data: LegalDecisionObject;
  source_pipeline_version: string | null;
  created_by: string | null;
  created_at: string;
  supersedes_decision_id: string | null;
  is_latest: boolean;
}

export interface SaveLegalDecisionOptions {
  caseId?: string | null;
  sourcePipelineVersion?: string | null;
  createdBy?: string | null;
}

export interface LegalDecisionRepositoryResult<T> {
  data: T | null;
  error: unknown | null;
}

export interface SaveLegalDecisionResult extends LegalDecisionRepositoryResult<LegalDecisionRow> {
  inserted: boolean;
  duplicate: boolean;
  superseded_decision_id: string | null;
}

// ── Client interface ──────────────────────────────────────────────────────────

export interface LegalDecisionRepositoryClient {
  schema?: (schema: string) => LegalDecisionRepositoryClient;
  from: (table: string) => LegalDecisionQueryBuilder;
  /**
   * Phase 7.5B: rpc is required for atomic snapshot saves.
   * Real Supabase client always provides this.  Test mocks must also implement it.
   */
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<LegalDecisionRepositoryResult<unknown>>;
}

interface SupabaseLikeClient extends LegalDecisionRepositoryClient {}

export interface LegalDecisionQueryBuilder
  extends PromiseLike<LegalDecisionRepositoryResult<unknown>> {
  select: (columns?: string) => LegalDecisionQueryBuilder;
  eq: (column: string, value: unknown) => LegalDecisionQueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => LegalDecisionQueryBuilder;
  limit: (count: number) => LegalDecisionQueryBuilder;
  maybeSingle: () => Promise<LegalDecisionRepositoryResult<LegalDecisionRow>>;
  single: () => Promise<LegalDecisionRepositoryResult<LegalDecisionRow>>;
  insert: (values: Record<string, unknown>) => LegalDecisionQueryBuilder;
  update: (values: Record<string, unknown>) => LegalDecisionQueryBuilder;
}

// ── saveLegalDecisionSnapshot — atomic via RPC (Phase 7.5B) ──────────────────

/**
 * Atomically saves a Legal Decision snapshot.
 *
 * Delegates to app.save_legal_decision_atomic which runs inside a single
 * Postgres transaction with an advisory lock on case_id:
 *   1. Advisory lock — serializes all concurrent saves for the same case
 *   2. Duplicate check — returns existing row if version_hash already exists
 *   3. UPDATE previous is_latest → false (before insert, no overlap window)
 *   4. INSERT new row with is_latest = true
 *
 * The partial unique index (legal_decisions_single_latest_idx) provides an
 * additional DB-level guarantee that at most one is_latest = true exists
 * per case_id.
 *
 * Public signature unchanged from Phase 7.1.
 */
export async function saveLegalDecisionSnapshot(
  client: SupabaseLikeClient,
  decision: LegalDecisionObject,
  options: SaveLegalDecisionOptions = {},
): Promise<SaveLegalDecisionResult> {
  const caseId = options.caseId ?? decision.case_id;
  if (!caseId) {
    return {
      data: null,
      error: { message: "case_id is required to persist a Legal Decision Object" },
      inserted: false,
      duplicate: false,
      superseded_decision_id: null,
    };
  }

  const rpcResult = await client.rpc("save_legal_decision_atomic", {
    p_case_id: caseId,
    p_version_hash: decision.version_hash,
    p_decision_status: decision.status,
    p_decision_data: cloneJson(decision) as unknown as Record<string, unknown>,
    p_source_pipeline_version: options.sourcePipelineVersion ?? null,
    p_created_by: options.createdBy ?? null,
  });

  if (rpcResult.error) {
    return saveError(rpcResult.error);
  }

  const row = rpcResult.data as Record<string, unknown>;
  const action = row["_action"] as string;
  const rowData = rpcRowToDecisionRow(row);

  return {
    data: rowData,
    error: null,
    inserted: action === "inserted",
    duplicate: action === "duplicate",
    superseded_decision_id: rowData.supersedes_decision_id,
  };
}

// ── Read queries (unchanged from Phase 7.1) ───────────────────────────────────

export async function getLatestLegalDecision(
  client: SupabaseLikeClient,
  caseId: string,
): Promise<LegalDecisionRepositoryResult<LegalDecisionRow>> {
  return await legalDecisionsTable(client)
    .select("*")
    .eq("case_id", caseId)
    .eq("is_latest", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function listLegalDecisionVersions(
  client: SupabaseLikeClient,
  caseId: string,
): Promise<LegalDecisionRepositoryResult<LegalDecisionRow[]>> {
  const result = await legalDecisionsTable(client)
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });
  return result as LegalDecisionRepositoryResult<LegalDecisionRow[]>;
}

/**
 * Utility: bulk-marks all is_latest rows for a case as false.
 * Used for admin/repair scenarios; normal saves go through saveLegalDecisionSnapshot.
 */
export async function markPreviousDecisionsNotLatest(
  client: SupabaseLikeClient,
  caseId: string,
): Promise<LegalDecisionRepositoryResult<LegalDecisionRow[]>> {
  const result = await legalDecisionsTable(client)
    .update({ is_latest: false })
    .eq("case_id", caseId)
    .eq("is_latest", true)
    .select("*");
  return result as LegalDecisionRepositoryResult<LegalDecisionRow[]>;
}

/**
 * Returns the current latest decision for a case (i.e. the row that would
 * be superseded by the next save).  Kept for callers that need to inspect
 * supersession state without performing a save.
 */
export async function computeDecisionSupersession(
  client: SupabaseLikeClient,
  caseId: string,
): Promise<LegalDecisionRepositoryResult<LegalDecisionRow>> {
  return await getLatestLegalD
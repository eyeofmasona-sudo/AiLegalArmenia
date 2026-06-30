import type { LegalDecisionObject, LegalDecisionStatus } from "./legal-decision-engine.ts";

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

export interface LegalDecisionRepositoryClient {
  schema?: (schema: string) => LegalDecisionRepositoryClient;
  from: (table: string) => LegalDecisionQueryBuilder;
}

interface SupabaseLikeClient extends LegalDecisionRepositoryClient {}

export interface LegalDecisionQueryBuilder extends PromiseLike<LegalDecisionRepositoryResult<unknown>> {
  select: (columns?: string) => LegalDecisionQueryBuilder;
  eq: (column: string, value: unknown) => LegalDecisionQueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => LegalDecisionQueryBuilder;
  limit: (count: number) => LegalDecisionQueryBuilder;
  maybeSingle: () => Promise<LegalDecisionRepositoryResult<LegalDecisionRow>>;
  single: () => Promise<LegalDecisionRepositoryResult<LegalDecisionRow>>;
  insert: (values: Record<string, unknown>) => LegalDecisionQueryBuilder;
  update: (values: Record<string, unknown>) => LegalDecisionQueryBuilder;
}

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

  const existing = await findByCaseAndHash(client, caseId, decision.version_hash);
  if (existing.error) return saveError(existing.error);
  if (existing.data) {
    return {
      data: existing.data,
      error: null,
      inserted: false,
      duplicate: true,
      superseded_decision_id: existing.data.supersedes_decision_id,
    };
  }

  const supersession = await computeDecisionSupersession(client, caseId);
  if (supersession.error) return saveError(supersession.error);

  const previousLatestId = supersession.data?.id ?? null;
  const insertPayload = {
    case_id: caseId,
    version_hash: decision.version_hash,
    decision_status: decision.status,
    decision_data: cloneJson(decision),
    source_pipeline_version: options.sourcePipelineVersion ?? null,
    created_by: options.createdBy ?? null,
    supersedes_decision_id: previousLatestId,
    is_latest: true,
  };

  const inserted = await legalDecisionsTable(client)
    .insert(insertPayload)
    .select("*")
    .single();

  if (inserted.error) {
    if (isUniqueViolation(inserted.error)) {
      const duplicate = await findByCaseAndHash(client, caseId, decision.version_hash);
      if (duplicate.data) {
        return {
          data: duplicate.data,
          error: null,
          inserted: false,
          duplicate: true,
          superseded_decision_id: duplicate.data.supersedes_decision_id,
        };
      }
    }
    return saveError(inserted.error, previousLatestId);
  }

  if (previousLatestId) {
    const updatePrevious = await markDecisionNotLatestById(client, previousLatestId);
    if (updatePrevious.error) {
      return {
        data: inserted.data,
        error: updatePrevious.error,
        inserted: true,
        duplicate: false,
        superseded_decision_id: previousLatestId,
      };
    }
  }

  return {
    data: inserted.data,
    error: null,
    inserted: true,
    duplicate: false,
    superseded_decision_id: previousLatestId,
  };
}

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

export async function computeDecisionSupersession(
  client: SupabaseLikeClient,
  caseId: string,
): Promise<LegalDecisionRepositoryResult<LegalDecisionRow>> {
  return await getLatestLegalDecision(client, caseId);
}

async function findByCaseAndHash(
  client: SupabaseLikeClient,
  caseId: string,
  versionHash: string,
): Promise<LegalDecisionRepositoryResult<LegalDecisionRow>> {
  return await legalDecisionsTable(client)
    .select("*")
    .eq("case_id", caseId)
    .eq("version_hash", versionHash)
    .maybeSingle();
}

async function markDecisionNotLatestById(
  client: SupabaseLikeClient,
  decisionId: string,
): Promise<LegalDecisionRepositoryResult<LegalDecisionRow[]>> {
  const result = await legalDecisionsTable(client)
    .update({ is_latest: false })
    .eq("id", decisionId)
    .select("*");
  return result as LegalDecisionRepositoryResult<LegalDecisionRow[]>;
}

function legalDecisionsTable(client: SupabaseLikeClient): LegalDecisionQueryBuilder {
  const scoped = typeof client.schema === "function" ? client.schema("app") : client;
  return scoped.from("legal_decisions");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "23505" || code === "409";
}

function saveError(error: unknown, supersededDecisionId: string | null = null): SaveLegalDecisionResult {
  return {
    data: null,
    error,
    inserted: false,
    duplicate: false,
    superseded_decision_id: supersededDecisionId,
  };
}

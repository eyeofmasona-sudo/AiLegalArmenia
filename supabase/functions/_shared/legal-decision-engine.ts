/**
 * Legal Decision Engine — Foundation (Phase 7.1)
 *
 * Pure deterministic builder for Legal Decision Objects.
 * No DB, no network, no fetch, no env, no LLM calls.
 */

export type LegalDecisionStatus =
  | "READY"
  | "WARNING"
  | "HUMAN_REVIEW_REQUIRED"
  | "BLOCKED";

export type LegalDecisionConfidenceLevel = "high" | "medium" | "low";
export type LegalDecisionProbability = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface LegalDecisionConfidence {
  level: LegalDecisionConfidenceLevel;
  numeric_score: number;
  reasons: string[];
}

export interface LegalDecisionRisk {
  code: string;
  severity: "low" | "medium" | "high" | "blocking";
  message: string;
}

export interface LegalDecisionContradiction {
  code: string;
  severity: "low" | "medium" | "high";
  description: string;
  fields?: string[];
}

export interface LegalDecisionMissingInformation {
  code: string;
  importance: "low" | "medium" | "high";
  description: string;
}

export interface LegalDecisionVerificationState {
  final_legal_qa_status: string | null;
  citation_risk_level: string | null;
  citations_verified: boolean | null;
  official_fact_check_status: string | null;
  temporal_validity_ok: boolean;
  source_hierarchy_ok: boolean;
  court_practice_strength: "strong" | "moderate" | "weak" | "none";
  warnings: string[];
  blocked_reasons: string[];
}

export interface LegalDecisionActionPlan {
  immediate_actions: string[];
  evidence_actions: string[];
  citation_actions: string[];
  review_actions: string[];
  next_steps: string[];
}

export interface LegalDecisionObject {
  decision_id: string;
  case_id: string | null;
  version_hash: string;
  status: LegalDecisionStatus;
  legal_position: string;
  confidence: LegalDecisionConfidence;
  probability_of_success: {
    level: LegalDecisionProbability;
    basis: "rule_based_only";
    disclaimer: string;
  };
  expert_assessments: Record<string, unknown>;
  conflicts_and_gaps: {
    risks: LegalDecisionRisk[];
    contradictions: LegalDecisionContradiction[];
    missing_information: LegalDecisionMissingInformation[];
  };
  verification_state: LegalDecisionVerificationState;
  action_plan: LegalDecisionActionPlan;
  explainability: {
    deciding_factors: string[];
    confidence_factors: string[];
    risk_factors: string[];
    why_human_review_required: string[];
    why_blocked: string[];
  };
  created_at: string;
}

export interface LegalDecisionInput {
  case_id?: string | null;
  legal_position?: string | null;
  expert_assessments?: Record<string, unknown> | null;
  final_legal_qa?: {
    final_legal_qa_status?: string | null;
    blocking_issues?: string[];
    warnings?: string[];
    requires_human_review?: boolean;
  } | null;
  citation_validation?: {
    citations_verified?: boolean | null;
    citation_risk_level?: string | null;
    missing_citations?: unknown[] | Record<string, unknown> | null;
    weak_citations?: unknown[] | Record<string, unknown> | null;
  } | null;
  official_source_fact_check?: {
    official_fact_check_status?: string | null;
    failed_sources?: unknown[];
    warnings?: string[];
    requires_human_review?: boolean;
  } | null;
  temporal_validations?: Array<{
    temporal_status?: string | null;
    usable_as_current_law?: boolean | null;
    temporal_valid?: boolean | null;
    title?: string | null;
    id?: string | null;
  }> | null;
  source_hierarchy?: {
    conflicts?: Array<{
      type?: string;
      severity?: string;
      warning?: string;
      cautious_output_required?: boolean;
      unresolved?: boolean;
    }>;
    source_use_warnings?: string[];
  } | null;
  court_practice?: {
    binding_practice?: Array<{ court_level?: string; title?: string }>;
    persuasive_practice?: Array<{ court_level?: string; title?: string }>;
    weak_practice?: Array<{ court_level?: string; title?: string }>;
    warnings?: string[];
    conflicts?: Array<{ warning?: string; cautious_output_required?: boolean }>;
  } | null;
  facts?: {
    confirmed_facts?: string[];
    disputed_facts?: string[];
    missing_facts?: string[];
  } | null;
  issues?: string[];
  generated_at?: string | null;
}

export type LegalDecisionVersionMaterial = Record<string, unknown>;

const FIXED_CREATED_AT = "1970-01-01T00:00:00.000Z";
const INVALID_TEMPORAL_STATUSES = new Set(["expired", "repealed", "not_yet_effective"]);
const UNRESOLVED_CONFLICT_TYPES = new Set([
  "unresolved_conflict",
  "municipal_over_statute",
  "lower_court_over_cassation",
  "inactive_source",
  "old_revision_without_warning",
]);

const TRANSIENT_VERSION_KEYS = new Set([
  "analysis",
  "ai_response",
  "checked_at",
  "created_at",
  "decision_id",
  "duration_ms",
  "elapsed_ms",
  "generated_at",
  "generated_text",
  "legal_position",
  "llm_output",
  "model_used",
  "pipeline_duration",
  "pipeline_errors",
  "pipeline_metadata",
  "pipeline_warnings",
  "qa_pipeline_version",
  "raw_text",
  "repository_record_id",
  "response_text",
  "supersedes_decision_id",
  "updated_at",
]);

export function buildDecisionVersionMaterial(input: LegalDecisionInput): LegalDecisionVersionMaterial {
  return normalizeMaterialForHash({
    case_id: input.case_id ?? null,
    material_assessments: input.expert_assessments ?? {},
    final_legal_qa: input.final_legal_qa ?? null,
    citation_validation: input.citation_validation ?? null,
    official_source_fact_check: input.official_source_fact_check ?? null,
    temporal_validations: input.temporal_validations ?? [],
    source_hierarchy: input.source_hierarchy ?? null,
    court_practice: input.court_practice ?? null,
    facts: input.facts ?? null,
    issues: input.issues ?? [],
  }) as LegalDecisionVersionMaterial;
}

export function computeDecisionVersionHash(material: LegalDecisionVersionMaterial): string {
  return stableHash(canonicalizeForHash(material));
}

export function buildLegalDecisionObject(input: LegalDecisionInput): LegalDecisionObject {
  const confidence = calculateDecisionConfidence(input);
  const contradictions = detectDecisionContradictions(input);
  const missingInformation = extractMissingInformation(input);
  const verificationState = buildDecisionVerificationState(input);
  const risks = buildRisks(input, verificationState);
  const status = determineStatus(input, confidence, verificationState, risks);
  const actionPlan = buildDecisionActionPlan(input);
  const explainability = buildExplainability(
    input,
    confidence,
    verificationState,
    risks,
    contradictions,
    missingInformation,
    status,
  );
  const version_hash = computeDecisionVersionHash(buildDecisionVersionMaterial(input));

  return {
    decision_id: `decision_${version_hash.slice(0, 16)}`,
    case_id: input.case_id ?? null,
    version_hash,
    status,
    legal_position: normalizeText(input.legal_position) || "UNSPECIFIED_LEGAL_POSITION",
    confidence,
    probability_of_success: {
      level: classifyProbability(confidence, status),
      basis: "rule_based_only",
      disclaimer: "Probability is a deterministic risk classification, not a statistical prediction.",
    },
    expert_assessments: input.expert_assessments ?? {},
    conflicts_and_gaps: {
      risks,
      contradictions,
      missing_information: missingInformation,
    },
    verification_state: verificationState,
    action_plan: actionPlan,
    explainability,
    created_at: input.generated_at ?? FIXED_CREATED_AT,
  };
}

export function calculateDecisionConfidence(input: LegalDecisionInput): LegalDecisionConfidence {
  let score = 70;
  const reasons: string[] = ["base_score:70"];

  const qaStatus = input.final_legal_qa?.final_legal_qa_status;
  if (qaStatus === "FAIL") {
    score -= 45;
    reasons.push("final_legal_qa_fail:-45");
  } else if (qaStatus === "REQUIRES_HUMAN_REVIEW") {
    score -= 30;
    reasons.push("final_legal_qa_human_review:-30");
  } else if (qaStatus === "WARNING") {
    score -= 10;
    reasons.push("final_legal_qa_warning:-10");
  } else if (qaStatus === "PASS") {
    score += 5;
    reasons.push("final_legal_qa_pass:+5");
  }

  const citationRisk = input.citation_validation?.citation_risk_level;
  if (citationRisk === "high") {
    score -= 30;
    reasons.push("citation_risk_high:-30");
  } else if (citationRisk === "medium") {
    score -= 15;
    reasons.push("citation_risk_medium:-15");
  } else if (citationRisk === "low") {
    score -= 5;
    reasons.push("citation_risk_low:-5");
  } else if (citationRisk === "none") {
    score += 5;
    reasons.push("citation_risk_none:+5");
  }

  const officialStatus = input.official_source_fact_check?.official_fact_check_status;
  if (officialStatus === "FAIL") {
    score -= 45;
    reasons.push("official_fact_check_fail:-45");
  } else if (officialStatus === "UNVERIFIED_OFFICIAL_SOURCE") {
    score -= 12;
    reasons.push("official_source_unverified:-12");
  } else if (officialStatus === "PASS") {
    score += 5;
    reasons.push("official_fact_check_pass:+5");
  }

  for (const temporal of input.temporal_validations ?? []) {
    if (temporal.temporal_status && INVALID_TEMPORAL_STATUSES.has(temporal.temporal_status)) {
      score -= 25;
      reasons.push(`temporal_${temporal.temporal_status}:-25`);
    }
  }

  const hierarchyConflicts = input.source_hierarchy?.conflicts ?? [];
  if (hierarchyConflicts.some(isUnresolvedHierarchyConflict)) {
    score -= 18;
    reasons.push("source_hierarchy_unresolved_conflict:-18");
  } else if (hierarchyConflicts.length > 0) {
    score -= 8;
    reasons.push("source_hierarchy_conflict:-8");
  }

  const missingFacts = input.facts?.missing_facts?.filter(Boolean) ?? [];
  if (missingFacts.length > 0) {
    const penalty = Math.min(25, missingFacts.length * 8);
    score -= penalty;
    reasons.push(`missing_facts:-${penalty}`);
  }

  const contradictions = detectDecisionContradictions(input);
  if (contradictions.length > 0) {
    const penalty = contradictions.some((c) => c.severity === "high") ? 22 : 12;
    score -= penalty;
    reasons.push(`contradictions:-${penalty}`);
  }

  const practiceStrength = classifyCourtPracticeStrength(input.court_practice);
  if (practiceStrength === "strong") {
    score += 12;
    reasons.push("strong_cassation_or_constitutional_practice:+12");
  } else if (practiceStrength === "moderate") {
    score += 5;
    reasons.push("moderate_court_practice:+5");
  } else if (practiceStrength === "weak") {
    score -= 4;
    reasons.push("weak_court_practice:-4");
  }

  score = clamp(score, 0, 100);
  return {
    level: score >= 75 ? "high" : score >= 45 ? "medium" : "low",
    numeric_score: score,
    reasons,
  };
}

export function detectDecisionContradictions(input: LegalDecisionInput): LegalDecisionContradiction[] {
  const contradictions: LegalDecisionContradiction[] = [];
  const position = normalizeText(input.legal_position).toLowerCase();
  const assessments = flattenValues(input.expert_assessments ?? {}).map((v) => v.toLowerCase());

  if (hasPositiveSignal(position) && assessments.some(hasNegativeSignal)) {
    contradictions.push({
      code: "position_conflicts_with_expert_assessment",
      severity: "high",
      description: "Legal position is positive while at least one expert assessment indicates high risk or weak position.",
      fields: ["legal_position", "expert_assessments"],
    });
  }
  if (hasNegativeSignal(position) && assessments.some(hasPositiveSignal)) {
    contradictions.push({
      code: "negative_position_conflicts_with_positive_assessment",
      severity: "medium",
      description: "Legal position is negative while at least one expert assessment indicates a strong position.",
      fields: ["legal_position", "expert_assessments"],
    });
  }
  if ((input.facts?.confirmed_facts ?? []).some((fact) => (input.facts?.disputed_facts ?? []).includes(fact))) {
    contradictions.push({
      code: "fact_confirmed_and_disputed",
      severity: "medium",
      description: "The same fact appears as both confirmed and disputed.",
      fields: ["facts.confirmed_facts", "facts.disputed_facts"],
    });
  }

  return contradictions;
}

export function extractMissingInformation(input: LegalDecisionInput): LegalDecisionMissingInformation[] {
  const missing: LegalDecisionMissingInformation[] = [];
  for (const fact of input.facts?.missing_facts ?? []) {
    if (!fact) continue;
    missing.push({
      code: stableCode(`missing_fact:${fact}`),
      importance: "high",
      description: fact,
    });
  }
  if (!normalizeText(input.legal_position)) {
    missing.push({
      code: "missing_legal_position",
      importance: "high",
      description: "Legal position is missing.",
    });
  }
  if (!input.citation_validation) {
    missing.push({
      code: "missing_citation_validation",
      importance: "medium",
      description: "Citation verification metadata is missing.",
    });
  }
  return missing.sort((a, b) => a.code.localeCompare(b.code));
}

export function buildDecisionVerificationState(input: LegalDecisionInput): LegalDecisionVerificationState {
  const temporalWarnings: string[] = [];
  let temporalValidityOk = true;
  for (const source of input.temporal_validations ?? []) {
    if (source.temporal_status && INVALID_TEMPORAL_STATUSES.has(source.temporal_status)) {
      temporalValidityOk = false;
      temporalWarnings.push(`temporal_${source.temporal_status}:${source.title ?? source.id ?? "source"}`);
    }
    if (source.usable_as_current_law === false || source.temporal_valid === false) {
      temporalValidityOk = false;
      temporalWarnings.push(`temporal_invalid:${source.title ?? source.id ?? "source"}`);
    }
  }

  const hierarchyConflicts = input.source_hierarchy?.conflicts ?? [];
  const sourceHierarchyOk = !hierarchyConflicts.some(isUnresolvedHierarchyConflict);
  const finalStatus = input.final_legal_qa?.final_legal_qa_status ?? null;
  const officialStatus = input.official_source_fact_check?.official_fact_check_status ?? null;
  const citationRisk = input.citation_validation?.citation_risk_level ?? null;
  const warnings = [
    ...(input.final_legal_qa?.warnings ?? []),
    ...(input.official_source_fact_check?.warnings ?? []),
    ...temporalWarnings,
    ...(input.source_hierarchy?.source_use_warnings ?? []),
  ].filter(Boolean).sort();
  const blocked_reasons: string[] = [];
  if (finalStatus === "FAIL") blocked_reasons.push("final_legal_qa_fail");
  if (officialStatus === "FAIL") blocked_reasons.push("official_fact_check_fail");

  return {
    final_legal_qa_status: finalStatus,
    citation_risk_level: citationRisk,
    citations_verified: input.citation_validation?.citations_verified ?? null,
    official_fact_check_status: officialStatus,
    temporal_validity_ok: temporalValidityOk,
    source_hierarchy_ok: sourceHierarchyOk,
    court_practice_strength: classifyCourtPracticeStrength(input.court_practice),
    warnings,
    blocked_reasons,
  };
}

export function buildDecisionActionPlan(input: LegalDecisionInput): LegalDecisionActionPlan {
  const missing = extractMissingInformation(input);
  const verification = buildDecisionVerificationState(input);
  const actions: LegalDecisionActionPlan = {
    immediate_actions: [],
    evidence_actions: [],
    citation_actions: [],
    review_actions: [],
    next_steps: [],
  };

  if (verification.blocked_reasons.length > 0) {
    actions.immediate_actions.push("Do not rely on this legal position until blocking verification issues are resolved.");
  }
  if (missing.length > 0) {
    actions.evidence_actions.push("Collect missing facts and documents identified in missing_information.");
  }
  if (verification.citation_risk_level === "high" || verification.citations_verified === false) {
    actions.citation_actions.push("Resolve missing or weak citations before using the decision.");
  }
  if (verification.official_fact_check_status === "UNVERIFIED_OFFICIAL_SOURCE") {
    actions.citation_actions.push("Perform human official-source spot-check before external use.");
  }
  if (!verification.temporal_validity_ok) {
    actions.review_actions.push("Review temporal validity and confirm correct legal revision.");
  }
  if (!verification.source_hierarchy_ok) {
    actions.review_actions.push("Resolve source hierarchy conflict before relying on conclusion.");
  }
  actions.next_steps.push("Use decision object as internal risk metadata, not as a court prediction.");
  return actions;
}

function determineStatus(
  input: LegalDecisionInput,
  confidence: LegalDecisionConfidence,
  verification: LegalDecisionVerificationState,
  risks: LegalDecisionRisk[],
): LegalDecisionStatus {
  if (input.final_legal_qa?.final_legal_qa_status === "FAIL") return "BLOCKED";
  if (input.official_source_fact_check?.official_fact_check_status === "FAIL") return "BLOCKED";
  if (input.final_legal_qa?.final_legal_qa_status === "REQUIRES_HUMAN_REVIEW") {
    return "HUMAN_REVIEW_REQUIRED";
  }
  if (input.citation_validation?.citation_risk_level === "high") return "HUMAN_REVIEW_REQUIRED";
  if (!verification.temporal_validity_ok) return "HUMAN_REVIEW_REQUIRED";
  if (risks.some((risk) => risk.severity === "high")) return "HUMAN_REVIEW_REQUIRED";
  if (
    input.official_source_fact_check?.official_fact_check_status === "UNVERIFIED_OFFICIAL_SOURCE" ||
    confidence.level !== "high" ||
    verification.warnings.length > 0
  ) {
    return "WARNING";
  }
  return "READY";
}

function buildRisks(input: LegalDecisionInput, verification: LegalDecisionVerificationState): LegalDecisionRisk[] {
  const risks: LegalDecisionRisk[] = [];
  if (input.final_legal_qa?.final_legal_qa_status === "FAIL") {
    risks.push({ code: "final_legal_qa_fail", severity: "blocking", message: "Final Legal QA failed." });
  }
  if (input.final_legal_qa?.final_legal_qa_status === "REQUIRES_HUMAN_REVIEW") {
    risks.push({ code: "final_legal_qa_human_review", severity: "high", message: "Final Legal QA requires human review." });
  }
  if (input.citation_validation?.citation_risk_level === "high") {
    risks.push({ code: "citation_risk_high", severity: "high", message: "Citation verification reports high risk." });
  }
  if (input.official_source_fact_check?.official_fact_check_status === "FAIL") {
    risks.push({ code: "official_fact_check_fail", severity: "blocking", message: "Official source fact-check failed." });
  }
  if (input.official_source_fact_check?.official_fact_check_status === "UNVERIFIED_OFFICIAL_SOURCE") {
    risks.push({ code: "official_source_unverified", severity: "medium", message: "Official source is unverified." });
  }
  if (!verification.temporal_validity_ok) {
    risks.push({ code: "temporal_validity_issue", severity: "high", message: "Temporal validity issue detected." });
  }
  if (!verification.source_hierarchy_ok) {
    risks.push({ code: "source_hierarchy_conflict", severity: "medium", message: "Unresolved source hierarchy conflict detected." });
  }
  return risks.sort((a, b) => a.code.localeCompare(b.code));
}

function buildExplainability(
  input: LegalDecisionInput,
  confidence: LegalDecisionConfidence,
  verification: LegalDecisionVerificationState,
  risks: LegalDecisionRisk[],
  contradictions: LegalDecisionContradiction[],
  missing: LegalDecisionMissingInformation[],
  status: LegalDecisionStatus,
) {
  return {
    deciding_factors: [
      `status:${status}`,
      `confidence:${confidence.level}:${confidence.numeric_score}`,
      `final_legal_qa:${verification.final_legal_qa_status ?? "missing"}`,
      `citation_risk:${verification.citation_risk_level ?? "missing"}`,
      `official_fact_check:${verification.official_fact_check_status ?? "missing"}`,
    ],
    confidence_factors: confidence.reasons,
    risk_factors: risks.map((risk) => `${risk.code}:${risk.severity}`),
    why_human_review_required: [
      ...(status === "HUMAN_REVIEW_REQUIRED" ? ["status_requires_human_review"] : []),
      ...risks.filter((risk) => risk.severity === "high").map((risk) => risk.code),
      ...contradictions.map((c) => c.code),
      ...missing.filter((m) => m.importance === "high").map((m) => m.code),
    ].sort(),
    why_blocked: [
      ...(status === "BLOCKED" ? ["status_blocked"] : []),
      ...verification.blocked_reasons,
      ...risks.filter((risk) => risk.severity === "blocking").map((risk) => risk.code),
    ].sort(),
  };
}

function classifyProbability(confidence: LegalDecisionConfidence, status: LegalDecisionStatus): LegalDecisionProbability {
  if (status === "BLOCKED") return "UNKNOWN";
  if (confidence.numeric_score >= 80) return "HIGH";
  if (confidence.numeric_score >= 55) return "MEDIUM";
  if (confidence.numeric_score >= 30) return "LOW";
  return "UNKNOWN";
}

function classifyCourtPracticeStrength(input: LegalDecisionInput["court_practice"]): "strong" | "moderate" | "weak" | "none" {
  const binding = input?.binding_practice ?? [];
  if (binding.some((p) => isStrongCourtLevel(p.court_level))) return "strong";
  if (binding.length > 0 || (input?.persuasive_practice ?? []).length > 0) return "moderate";
  if ((input?.weak_practice ?? []).length > 0) return "weak";
  return "none";
}

function isStrongCourtLevel(level?: string): boolean {
  const value = (level ?? "").toLowerCase();
  return value.includes("cassation") || value.includes("constitutional");
}

function isUnresolvedHierarchyConflict(conflict: { type?: string; severity?: string; unresolved?: boolean; cautious_output_required?: boolean }): boolean {
  return Boolean(
    conflict.unresolved ||
      conflict.severity === "high" ||
      (conflict.type && UNRESOLVED_CONFLICT_TYPES.has(conflict.type)) ||
      conflict.cautious_output_required,
  );
}

function normalizeText(value?: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function hasPositiveSignal(value: string): boolean {
  return /\b(strong|good|likely|valid|supported|բարձր|ուժեղ)\b/i.test(value);
}

function hasNegativeSignal(value: string): boolean {
  return /\b(weak|risk|unlikely|invalid|unsupported|low|թույլ|ռիսկ)\b/i.test(value);
}

function flattenValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenValues);
  if (value === null || value === undefined) return [];
  return [String(value)];
}

function stableCode(value: string): string {
  return `missing_${stableHash(value).slice(0, 12)}`;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function canonicalizeForHash(value: unknown): string {
  return JSON.stringify(sortValueForHash(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function normalizeMaterialForHash(value: unknown): unknown {
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeMaterialForHash).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (TRANSIENT_VERSION_KEYS.has(key)) continue;
      const normalized = normalizeMaterialForHash(raw);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  if (value === undefined) return undefined;
  return value;
}

function sortValueForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValueForHash).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValueForHash((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableHash(input: string): string {
  let hash1 = 0x811c9dc5;
  let hash2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash1 ^= code;
    hash1 = Math.imul(hash1, 0x01000193);
    hash2 ^= code + i;
    hash2 = Math.imul(hash2, 0x85ebca6b);
  }
  return `${toHex(hash1)}${toHex(hash2)}${toHex(hash1 ^ hash2)}${toHex(Math.imul(hash1, hash2))}`;
}

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

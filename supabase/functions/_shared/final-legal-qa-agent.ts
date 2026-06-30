/**
 * Final Legal QA Agent — PHASE 6.7C
 *
 * Pure QA gate for multi-agent legal pipeline output.
 * Evaluates already-computed metadata and returns a QA verdict.
 *
 * CONSTRAINTS:
 *   - No DB calls, no AI calls, no network calls.
 *   - Does NOT rewrite generated text or block output.
 *   - Does NOT modify legal position.
 *   - Attaches metadata only. safe_to_show_user is false ONLY for FAIL.
 *   - If FAIL or REQUIRES_HUMAN_REVIEW → requires_human_review = true.
 */

// ---------------------------------------------------------------------------
// Status type
// ---------------------------------------------------------------------------

export type FinalLegalQAStatus =
  | "PASS"
  | "WARNING"
  | "REQUIRES_HUMAN_REVIEW"
  | "FAIL"
  | "NOT_RUN";

// ---------------------------------------------------------------------------
// Minimal structural input shapes
// Compatible with actual engine output types via structural subtyping.
// Keeps this module import-free (no heavy transitive deps).
// ---------------------------------------------------------------------------

interface CitationValidationLike {
  citation_risk_level?: "none" | "low" | "medium" | "high" | null;
  citations_verified?: boolean;
}

interface OfficialFactCheckLike {
  official_fact_check_status?: string | null;
  failed_sources?: unknown[];
  warnings?: string[];
  requires_human_review?: boolean;
}

interface SourceConflictLike {
  type?: string;
  cautious_output_required?: boolean;
  warning?: string;
}

interface SourceHierarchyLike {
  conflicts?: SourceConflictLike[];
  source_use_warnings?: string[];
  auxiliary_sources?: Array<{ source_level?: string; binding_status?: string }>;
}

interface TemporalValidationLike {
  temporal_status?: string;
  temporal_valid?: boolean;
  usable_as_current_law?: boolean;
  temporal_warnings?: string[];
  title?: string;
  id?: string;
  document_id?: string;
}

interface CourtPracticeLike {
  weak_practice?: Array<{ court_level?: string; warnings?: string[] }>;
  binding_practice?: Array<{ court_level?: string; warnings?: string[] }>;
  conflicts?: Array<{ cautious_output_required?: boolean; warning?: string }>;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Input / Output interfaces
// ---------------------------------------------------------------------------

export interface FinalLegalQAInput {
  /** The raw generated text from the agent. Used for length/content sanity only. */
  generatedText: string;
  agentType?: string | null;
  mode?: string | null;
  /** CitationValidation from citation-verifier.ts */
  citationValidation?: CitationValidationLike | null;
  /** OfficialSourceFactCheckResult from official-source-fact-checker.ts */
  officialSourceFactCheck?: OfficialFactCheckLike | null;
  /** SourceHierarchyContext from source-hierarchy-engine.ts */
  sourceHierarchy?: SourceHierarchyLike | null;
  /**
   * Array of TemporalValidation objects from temporal-validity-engine.ts.
   * Typically grounding.legal_reasoning.temporal_validation.validated_sources.
   */
  temporalValidations?: TemporalValidationLike[] | null;
  /** CourtPracticeContext from court-practice-engine.ts */
  courtPractice?: CourtPracticeLike | null;
  /** grounding.ok from GroundingResult */
  groundingOk?: boolean | null;
  /** grounding.stop_code from GroundingResult */
  groundingStopCode?: string | null;
  /** grounding.legal_reasoning.risk_flags */
  legalReasoningRiskFlags?: string[] | null;
}

export interface FinalLegalQAResult {
  final_legal_qa_status: FinalLegalQAStatus;
  /** Confidence in the QA evaluation itself — degrades when key inputs are absent. */
  confidence: "high" | "medium" | "low";
  /** Issues that triggered FAIL or REQUIRES_HUMAN_REVIEW. */
  blocking_issues: string[];
  /** Non-blocking issues that triggered WARNING. */
  warnings: string[];
  /** true when status is FAIL or REQUIRES_HUMAN_REVIEW. */
  requires_human_review: boolean;
  /** false ONLY for FAIL. true for PASS / WARNING / REQUIRES_HUMAN_REVIEW. */
  safe_to_show_user: boolean;
  /** Human-readable one-line summary. */
  qa_summary: string;
  /** ISO 8601 timestamp of when the check ran. */
  checked_at: string;
  agent_type?: string;
  mode?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Severity precedence. Higher number = more severe. */
const STATUS_RANK: Record<FinalLegalQAStatus, number> = {
  NOT_RUN: 0,
  PASS: 1,
  WARNING: 2,
  REQUIRES_HUMAN_REVIEW: 3,
  FAIL: 4,
};

function mergeStatus(
  current: FinalLegalQAStatus,
  next: FinalLegalQAStatus,
): FinalLegalQAStatus {
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

/**
 * Source conflict types that require REQUIRES_HUMAN_REVIEW (not merely WARNING).
 */
const HIGH_SEVERITY_CONFLICT_TYPES = new Set([
  "inactive_source",
  "lower_court_conflict_with_cassation",
  "municipal_conflict_with_higher_law",
  "subordinate_conflict_with_statute",
]);

/**
 * Temporal status values that indicate a source cannot be used as current law.
 */
const INVALID_TEMPORAL_STATUSES = new Set([
  "expired",
  "repealed",
  "not_yet_effective",
]);

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Evaluate the quality of a multi-agent legal analysis.
 *
 * Consumes pre-computed metadata inputs. Returns a structured QA verdict.
 * Does NOT call AI, DB, or any external service.
 * Does NOT modify or rewrite the generatedText.
 */
export function runFinalLegalQA(input: FinalLegalQAInput): FinalLegalQAResult {
  const blocking_issues: string[] = [];
  const warnings: string[] = [];
  let status: FinalLegalQAStatus = "PASS";

  // ── Rule 1: Insufficient legal grounding → FAIL ────────────────────────────
  if (input.groundingOk === false) {
    status = mergeStatus(status, "FAIL");
    blocking_issues.push(
      "INSUFFICIENT_LEGAL_GROUNDING: Legal retrieval failed or returned no usable sources. Output may lack factual basis.",
    );
  }
  if (input.groundingStopCode === "INSUFFICIENT_LEGAL_GROUNDING") {
    status = mergeStatus(status, "FAIL");
    if (!blocking_issues.some((m) => m.startsWith("INSUFFICIENT_LEGAL_GROUNDING"))) {
      blocking_issues.push(
        "INSUFFICIENT_LEGAL_GROUNDING: grounding.stop_code signalled that no usable sources were retrieved.",
      );
    }
  }

  // ── Rule 2: Official source fact-check FAIL → FAIL ────────────────────────
  const fsStatus = input.officialSourceFactCheck?.official_fact_check_status ?? null;
  if (fsStatus === "FAIL") {
    status = mergeStatus(status, "FAIL");
    blocking_issues.push(
      "OFFICIAL_SOURCE_FAIL: One or more official source checks explicitly failed. Source attribution is unreliable.",
    );
  } else if (fsStatus === "UNVERIFIED_OFFICIAL_SOURCE") {
    // ── Rule 3: Unverified official sources → WARNING ─────────────────────────
    status = mergeStatus(status, "WARNING");
    warnings.push(
      "OFFICIAL_SOURCE_UNVERIFIED: Official sources could not be verified (stub mode). Human spot-check recommended before relying on citations.",
    );
  }

  // ── Rule 4: Citation risk high → REQUIRES_HUMAN_REVIEW ────────────────────
  const citRisk = input.citationValidation?.citation_risk_level ?? null;
  if (citRisk === "high") {
    status = mergeStatus(status, "REQUIRES_HUMAN_REVIEW");
    blocking_issues.push(
      "CITATION_RISK_HIGH: Citation verification found high-risk issues (missing or unverifiable citations). Requires manual review.",
    );
  } else if (citRisk === "medium") {
    status = mergeStatus(status, "WARNING");
    warnings.push(
      "CITATION_RISK_MEDIUM: Some citations could not be fully verified. Use cautious language when referencing these.",
    );
  }

  // ── Rule 5: Temporal invalidity — expired/repealed/future source ───────────
  for (const tv of input.temporalValidations ?? []) {
    if (tv.temporal_status && INVALID_TEMPORAL_STATUSES.has(tv.temporal_status)) {
      status = mergeStatus(status, "REQUIRES_HUMAN_REVIEW");
      const label =
        tv.title ?? tv.document_id ?? tv.id ?? `source(${tv.temporal_status})`;
      blocking_issues.push(
        `TEMPORAL_INVALID_SOURCE: Source "${label}" has temporal_status="${tv.temporal_status}" — cannot be used as current law.`,
      );
    }
  }

  // ── Rule 6: Source hierarchy conflicts ────────────────────────────────────
  for (const conflict of input.sourceHierarchy?.conflicts ?? []) {
    const ctype = conflict.type ?? "unknown_conflict";
    if (HIGH_SEVERITY_CONFLICT_TYPES.has(ctype)) {
      status = mergeStatus(status, "REQUIRES_HUMAN_REVIEW");
      blocking_issues.push(
        `SOURCE_CONFLICT_SEVERE: Hierarchy conflict "${ctype}" — cautious output required. ${conflict.warning ?? ""}`.trim(),
      );
    } else if (ctype === "unknown_source") {
      status = mergeStatus(status, "WARNING");
      warnings.push(
        `SOURCE_CONFLICT_UNKNOWN: Unknown-authority source in output. ${conflict.warning ?? ""}`.trim(),
      );
    } else if (conflict.cautious_output_required) {
      status = mergeStatus(status, "WARNING");
      warnings.push(
        `SOURCE_CONFLICT: Hierarchy conflict "${ctype}" — cautious language required. ${conflict.warning ?? ""}`.trim(),
      );
    }
  }

  // ── Rule 7: Venice Commission used as binding law ─────────────────────────
  const srcUseWarnings = input.sourceHierarchy?.source_use_warnings ?? [];
  if (srcUseWarnings.includes("venice_commission_cannot_be_binding")) {
    status = mergeStatus(status, "REQUIRES_HUMAN_REVIEW");
    blocking_issues.push(
      "VENICE_MISUSE: Venice Commission document treated as binding law. Venice Commission is advisory/auxiliary only under RA legal hierarchy.",
    );
  }

  // ── Rule 8: ECHR as domestic law replacement without explanation ───────────
  if (srcUseWarnings.includes("echr_requires_domestic_law_explanation")) {
    status = mergeStatus(status, "REQUIRES_HUMAN_REVIEW");
    blocking_issues.push(
      "ECHR_MISUSE: ECHR/ECtHR case law used as substitute for domestic law without a domestic legal anchor. A domestic norm bridge is required.",
    );
  }

  // ── Rule 9: Court practice conflicts (first-instance as binding, etc.) ─────
  for (const conflict of input.courtPractice?.conflicts ?? []) {
    if (conflict.cautious_output_required) {
      status = mergeStatus(status, "REQUIRES_HUMAN_REVIEW");
      blocking_issues.push(
        `COURT_PRACTICE_CONFLICT: ${conflict.warning ?? "Court practice hierarchy conflict — requires cautious treatment."}`,
      );
    }
  }
  // Weak court practice warnings (informational)
  const cpWarnings = input.courtPractice?.warnings ?? [];
  if (cpWarnings.some((w) => w.includes("first_instance_weak_persuasive_only"))) {
    status = mergeStatus(status, "WARNING");
    warnings.push(
      "FIRST_INSTANCE_ONLY: First-instance court practice is weak persuasive — it is not a binding precedent under RA judicial hierarchy.",
    );
  }
  if (cpWarnings.some((w) => w.includes("venice_not_court_practice_auxiliary_only"))) {
    status = mergeStatus(status, "WARNING");
    warnings.push(
      "VENICE_COURT_PRACTICE_WARNING: Venice Commission document appears in court practice context but is not court practice — auxiliary only.",
    );
  }

  // ── Rule 10: Legal reasoning risk flags ───────────────────────────────────
  const riskFlags = input.legalReasoningRiskFlags ?? [];
  if (riskFlags.length > 0) {
    status = mergeStatus(status, "WARNING");
    warnings.push(`LEGAL_REASONING_FLAGS: ${riskFlags.slice(0, 5).join("; ")}`);
  }

  // ── Sanity: empty generated text ─────────────────────────────────────────
  if (!input.generatedText || input.generatedText.trim().length === 0) {
    status = mergeStatus(status, "FAIL");
    blocking_issues.push("EMPTY_OUTPUT: Generated text is empty — nothing to evaluate.");
  }

  // ── Derive output fields ──────────────────────────────────────────────────
  const requires_human_review = status === "FAIL" || status === "REQUIRES_HUMAN_REVIEW";
  const safe_to_show_user = status !== "FAIL";
  const confidence = _computeConfidence(input, status);
  const qa_summary = _buildQASummary(status, blocking_issues, warnings);

  const result: FinalLegalQAResult = {
    final_legal_qa_status: status,
    confidence,
    blocking_issues,
    warnings,
    requires_human_review,
    safe_to_show_user,
    qa_summary,
    checked_at: new Date().toISOString(),
  };
  if (input.agentType) result.agent_type = input.agentType;
  if (input.mode) result.mode = input.mode;

  return result;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _computeConfidence(
  input: FinalLegalQAInput,
  status: FinalLegalQAStatus,
): "high" | "medium" | "low" {
  if (status === "FAIL") return "low";
  const presentCount = [
    input.groundingOk !== undefined && input.groundingOk !== null,
    !!input.citationValidation,
    !!input.officialSourceFactCheck,
    !!input.sourceHierarchy,
    !!(input.temporalValidations && input.temporalValidations.length > 0),
  ].filter(Boolean).length;
  if (presentCount >= 4) return status === "PASS" ? "high" : "medium";
  if (presentCount >= 2) return "medium";
  return "low";
}

function _buildQASummary(
  status: FinalLegalQAStatus,
  blocking_issues: string[],
  warnings: string[],
): string {
  switch (status) {
    case "PASS":
      return "All QA checks passed. Output is safe to show to the user.";
    case "WARNING":
      return `QA WARNING: ${warnings.length} non-blocking issue(s) found. Output is shown with caveats.`;
    case "REQUIRES_HUMAN_REVIEW":
      return `QA REQUIRES HUMAN REVIEW: ${blocking_issues.length} issue(s) flagged. Output is attached but must be reviewed before relying on it.`;
    case "FAIL":
      return `QA FAILED: ${blocking_issues.length} blocking issue(s). Output should NOT be shown without human review and correction.`;
    default:
      return "QA not run.";
  }
}

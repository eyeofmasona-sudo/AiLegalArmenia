// Court Practice Engine
// -----------------------------------------------------------------------------
// Classifies judicial practice (RA + ECHR) by court level, juridical weight,
// applicability and link to norms. Pure functions over practice-source objects
// already produced by rag-search / vector-search (PracticeSearchResult-like).
//
// Does NOT touch DB schema, RPCs, prompts, or UI. Reuses temporal-validity-engine
// for "outdated" detection so temporal semantics stay consistent project-wide.
//
// Authority model (Republic of Armenia):
//   Constitutional Court  -> binding for constitutional interpretation
//   Court of Cassation    -> highest domestic judicial guidance (binding)
//   Appellate Court       -> persuasive, lower weight; cannot override Cassation
//   First Instance Court  -> weak persuasive only; never a strong precedent
//   ECHR                  -> binding/interpretive for human-rights / Convention
//                            standards; does NOT replace domestic law w/o reason
//   Venice Commission     -> NOT court practice; auxiliary only
// -----------------------------------------------------------------------------

import { classifyTemporalStatus, type TemporalStatus } from "./temporal-validity-engine.ts";

export type CourtLevel =
  | "constitutional_court"
  | "cassation_court"
  | "appellate_court"
  | "first_instance_court"
  | "echr"
  | "unknown_court";

export type PracticeWeightClass = "binding" | "persuasive" | "weak" | "echr" | "auxiliary" | "unknown";

export type PracticeUse =
  | "binding_precedent"
  | "persuasive_support"
  | "constitutional_authority"
  | "human_rights_standard"
  | "override_cassation"
  | "replace_domestic_law"
  | "document_generation_binding"
  | string;

/** Minimal practice-source shape (compatible with PracticeSearchResult / LegalSourceLike). */
export interface PracticeSourceLike {
  id?: string;
  document_id?: string;
  chunk_id?: string;
  title?: string;
  practice_category?: string;
  court_type?: string;
  court_name?: string;
  source_name?: string;
  citation_anchor?: string;
  content_text?: string;
  content_snippet?: string;
  legal_reasoning_summary?: string;
  outcome?: string;
  holding?: string;
  legal_issue?: string;
  applied_articles?: Array<string | Record<string, unknown>> | Record<string, unknown>[];
  key_violations?: string[];
  decision_date?: string | null;
  case_number?: string;
  norm_status?: string | null;
  normalized_status?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  is_current?: boolean | null;
  similarity?: number;
  score?: number;
  // Optional caller-provided position hints (engine never invents these).
  supports_user_position?: boolean | null;
  supports_opposing_position?: boolean | null;
  distinguishable?: boolean | null;
}

export interface ClassifiedPractice {
  id: string;
  is_court_practice: boolean;
  // (1) court_level
  court_level: CourtLevel;
  court_label: string;
  weight_class: PracticeWeightClass;
  /** Higher = stronger authority. Context-aware (constitutional issues lift CC). */
  authority_weight: number;
  // (2) case_number
  case_number: string | null;
  // (3) decision_date
  decision_date: string | null;
  // (4) legal_issue
  legal_issue: string | null;
  // (5) linked_norms
  linked_norms: string[];
  // (6) holding / legal position
  holding: string | null;
  // (7) binding  (8) persuasive
  binding: boolean;
  persuasive: boolean;
  // (9) distinguishable
  distinguishable: boolean;
  // (10) outdated
  outdated: boolean;
  temporal_status: TemporalStatus;
  // (11) conflicting_with_higher_practice
  conflicting_with_higher_practice: boolean;
  // (12) supports_user_position  (13) supports_opposing_position
  supports_user_position: boolean | null;
  supports_opposing_position: boolean | null;
  // ECHR special handling
  requires_domestic_link: boolean;
  warnings: string[];
}

export interface NormRef {
  id?: string;
  article_number?: string;
  act_name?: string;
  citation_anchor?: string;
  reference?: string;
  title?: string;
}

export interface PracticeNormLink {
  practice_id: string;
  norm_refs: string[];
  matched_norm_ids: string[];
}

export interface PracticeConflict {
  type: "higher_vs_lower" | "outdated_vs_newer";
  issue: string | null;
  higher?: ClassifiedPractice;
  lower?: ClassifiedPractice;
  newer?: ClassifiedPractice;
  older?: ClassifiedPractice;
  sources: string[];
  warning: string;
  cautious_output_required: boolean;
}

export interface CourtPracticeContext {
  ranked_practice: ClassifiedPractice[];
  binding_practice: ClassifiedPractice[];
  persuasive_practice: ClassifiedPractice[];
  weak_practice: ClassifiedPractice[];
  echr_practice: ClassifiedPractice[];
  conflicts: PracticeConflict[];
  linked_norms: PracticeNormLink[];
  warnings: string[];
}

export interface CourtPracticeReasoningContext {
  issues?: {
    legal_issues?: string[];
    human_rights_issues?: string[];
    [k: string]: unknown;
  };
  retrieval_plan?: {
    norm_anchors?: Array<{ article?: string; act_name?: string; raw?: string }>;
    [k: string]: unknown;
  };
  constitutional_issue?: boolean;
  human_rights_issue?: boolean;
  norms?: NormRef[];
  effective_at?: string | null;
}

// --- Court-level base weights (used for ranking & conflict resolution) -------
const BASE_WEIGHT: Record<CourtLevel, number> = {
  constitutional_court: 88, // lifted to 100 for constitutional issues (see ranking)
  cassation_court: 90,
  echr: 85,
  appellate_court: 50,
  first_instance_court: 20,
  unknown_court: 10,
};

const COURT_LABEL: Record<CourtLevel, string> = {
  constitutional_court: "Constitutional Court of Armenia",
  cassation_court: "Court of Cassation of Armenia",
  appellate_court: "Appellate Court of Armenia",
  first_instance_court: "First Instance Court of Armenia",
  echr: "European Court of Human Rights",
  unknown_court: "Unknown court",
};

function textOf(s: PracticeSourceLike): string {
  return [
    s.title, s.practice_category, s.court_type, s.court_name, s.source_name,
    s.citation_anchor, s.legal_issue, s.holding, s.legal_reasoning_summary,
    s.content_snippet, s.content_text,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isVenice(text: string): boolean {
  return /venice commission|վենետիկ|венециан/iu.test(text);
}

/** Detect court level from court_type / practice_category / free text (hy/ru/en). */
export function detectCourtLevel(s: PracticeSourceLike): CourtLevel {
  const ct = String(s.court_type || "").toLowerCase();
  const pc = String(s.practice_category || "").toLowerCase();
  const text = textOf(s);

  if (ct === "echr" || pc === "echr" || /\becthr\b|\bechr\b|european court of human rights|մարդու իրավունքների եվրոպական դատարան|еспч/iu.test(text)) {
    return "echr";
  }

  // Enum-style court_type tokens (e.g. "constitutional_court", "cassation",
  // "appellate_court", "first_instance_court") — checked before prose regex.
  const ctNorm = ct.replace(/[^a-z]/g, "");
  if (ctNorm) {
    if (ctNorm.includes("constitutional")) return "constitutional_court";
    if (ctNorm.includes("cassation")) return "cassation_court";
    if (ctNorm.includes("appell")) return "appellate_court";
    if (ctNorm.includes("firstinstance")) return "first_instance_court";
  }
  if (/constitutional court|սահմանադրական դատարան|конституционн[а-я]* суд/iu.test(text)) return "constitutional_court";
  if (/cassation|վճռաբեկ|кассац/iu.test(text)) return "cassation_court";
  if (/appellate|appeal court|court of appeal|վերաքննիչ|апелляц/iu.test(text)) return "appellate_court";
  if (/first instance|առաջին ատյան|первой инстанции|суд первой инстанции/iu.test(text)) return "first_instance_court";
  return "unknown_court";
}

function weightClassFor(level: CourtLevel, isCourt: boolean): PracticeWeightClass {
  if (!isCourt) return "auxiliary";
  switch (level) {
    case "constitutional_court":
    case "cassation_court":
      return "binding";
    case "echr":
      return "echr";
    case "appellate_court":
      return "persuasive";
    case "first_instance_court":
      return "weak";
    default:
      return "unknown";
  }
}

function firstString(...vals: Array<unknown>): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalizeArticleTokens(s: PracticeSourceLike): string[] {
  const out = new Set<string>();
  const aa = s.applied_articles;
  if (Array.isArray(aa)) {
    for (const a of aa) {
      if (typeof a === "string" && a.trim()) out.add(a.trim());
      else if (a && typeof a === "object") {
        const obj = a as Record<string, unknown>;
        const v = obj.article_number ?? obj.article ?? obj.number ?? obj.unit_number;
        if (typeof v === "string" && v.trim()) out.add(v.trim());
        else if (typeof v === "number") out.add(String(v));
      }
    }
  }
  // also harvest "article N" / "հոդված N" / "ст. N" from anchor + holding text
  const text = [s.citation_anchor, s.holding, s.legal_reasoning_summary, s.legal_issue].filter(Boolean).join(" ");
  for (const m of text.matchAll(/(?:article|art\.?|հոդված|ст(?:атья|\.)?)\s*([0-9]+(?:\.[0-9]+)?)/giu)) {
    out.add(m[1]);
  }
  return [...out];
}

/** Classify a single practice source. Context lifts CC weight on constitutional issues. */
export function classifyCourtPractice(
  source: PracticeSourceLike,
  ctx: CourtPracticeReasoningContext = {},
): ClassifiedPractice {
  const id = String(source.id || source.document_id || source.chunk_id || source.title || "unknown");
  const text = textOf(source);
  const venice = isVenice(text);
  const level = venice ? "unknown_court" : detectCourtLevel(source);
  const isCourt = !venice && level !== "unknown_court";
  const weight_class = weightClassFor(level, isCourt);

  const temporal_status = classifyTemporalStatus(
    { ...source, decision_date: source.decision_date ?? null },
    ctx.effective_at ?? undefined,
  );
  const outdated = ["repealed", "expired", "conflicting_revision"].includes(temporal_status) ||
    source.is_current === false ||
    ["repealed", "superseded", "inactive", "expired"].includes(String(source.norm_status || "").toLowerCase());

  const constitutionalIssue = ctx.constitutional_issue === true ||
    (ctx.issues?.legal_issues || []).some((i) => /constitution|սահմանադր|конституц/iu.test(String(i)));

  let authority_weight = BASE_WEIGHT[level];
  if (level === "constitutional_court" && constitutionalIssue) authority_weight = 100;
  if (outdated) authority_weight = Math.max(1, authority_weight - 40);

  // distinguishable: explicit hint, or low retrieval similarity (similar issue, facts likely differ)
  const sim = typeof source.similarity === "number" ? source.similarity
    : typeof source.score === "number" ? source.score : undefined;
  const distinguishable = source.distinguishable === true ||
    (source.distinguishable !== false && typeof sim === "number" && sim > 0 && sim < 0.5);

  const binding = isCourt && (level === "constitutional_court" || level === "cassation_court" || level === "echr") && !outdated;
  const persuasive = isCourt && (level === "appellate_court" || level === "first_instance_court" || (level === "echr"));

  const warnings: string[] = [];
  if (venice) warnings.push("venice_not_court_practice_auxiliary_only");
  if (level === "unknown_court" && !venice) warnings.push("court_level_unknown_low_weight");
  if (level === "first_instance_court") warnings.push("first_instance_weak_persuasive_only");
  if (level === "echr") warnings.push("echr_requires_domestic_link");
  if (outdated) warnings.push("practice_outdated_or_superseded");
  if (distinguishable) warnings.push("facts_may_be_distinguishable");

  return {
    id,
    is_court_practice: isCourt,
    court_level: level,
    court_label: venice ? "Venice Commission (auxiliary, not court practice)" : COURT_LABEL[level],
    weight_class,
    authority_weight,
    case_number: firstString(source.case_number, source.citation_anchor),
    decision_date: source.decision_date ?? null,
    legal_issue: firstString(source.legal_issue),
    linked_norms: normalizeArticleTokens(source),
    holding: firstString(source.holding, source.legal_reasoning_summary, source.outcome),
    binding,
    persuasive,
    distinguishable,
    outdated,
    temporal_status,
    conflicting_with_higher_practice: false, // set by detectPracticeConflicts
    supports_user_position: source.supports_user_position ?? null,
    supports_opposing_position: source.supports_opposing_position ?? null,
    requires_domestic_link: level === "echr",
    warnings,
  };
}

/** Rank practices by authority weight (desc); ties broken by recency then case number. */
export function rankCourtPractice(
  practices: PracticeSourceLike[],
  ctx: CourtPracticeReasoningContext = {},
): ClassifiedPractice[] {
  return practices
    .map((p) => classifyCourtPractice(p, ctx))
    .sort((a, b) =>
      b.authority_weight - a.authority_weight ||
      String(b.decision_date || "").localeCompare(String(a.decision_date || "")) ||
      String(a.case_number || "").localeCompare(String(b.case_number || "")),
    );
}

function normRefTokens(n: NormRef): string[] {
  const out = new Set<string>();
  if (n.article_number) out.add(String(n.article_number));
  if (n.reference) {
    for (const m of String(n.reference).matchAll(/([0-9]+(?:\.[0-9]+)?)/g)) out.add(m[1]);
  }
  if (n.citation_anchor) {
    for (const m of String(n.citation_anchor).matchAll(/([0-9]+(?:\.[0-9]+)?)/g)) out.add(m[1]);
  }
  return [...out];
}

/** Link each practice to provided norms by shared article number / reference. */
export function linkPracticeToNorms(
  practices: PracticeSourceLike[],
  norms: NormRef[],
): PracticeNormLink[] {
  const classified = practices.map((p) => classifyCourtPractice(p));
  return classified.map((cp) => {
    const matched_norm_ids: string[] = [];
    const norm_refs = new Set<string>();
    for (const n of norms || []) {
      const tokens = normRefTokens(n);
      const hit = tokens.some((t) => cp.linked_norms.includes(t));
      if (hit) {
        if (n.id) matched_norm_ids.push(n.id);
        const label = n.title || n.act_name || n.reference || n.citation_anchor ||
          (n.article_number ? `article ${n.article_number}` : "");
        if (label) norm_refs.add(label);
      }
    }
    return { practice_id: cp.id, norm_refs: [...norm_refs], matched_norm_ids };
  }).filter((l) => l.norm_refs.length > 0 || l.matched_norm_ids.length > 0);
}

const LEVEL_RANK: Record<CourtLevel, number> = {
  constitutional_court: 5,
  cassation_court: 4,
  echr: 3,
  appellate_court: 2,
  first_instance_court: 1,
  unknown_court: 0,
};

function sameIssue(a: ClassifiedPractice, b: ClassifiedPractice): boolean {
  // shared linked norm == same legal question proxy; or overlapping issue text
  if (a.linked_norms.some((x) => b.linked_norms.includes(x))) return true;
  if (a.legal_issue && b.legal_issue) {
    return a.legal_issue.toLowerCase() === b.legal_issue.toLowerCase();
  }
  return false;
}

/**
 * Detect conflicts:
 *  - higher_vs_lower: a lower court's position opposing a higher court on same issue.
 *  - outdated_vs_newer: an outdated practice on the same issue as a newer one.
 * Mutates `conflicting_with_higher_practice` on the lower/outdated members.
 */
export function detectPracticeConflicts(
  practices: PracticeSourceLike[],
  ctx: CourtPracticeReasoningContext = {},
): PracticeConflict[] {
  const ranked = practices.map((p) => classifyCourtPractice(p, ctx));
  const conflicts: PracticeConflict[] = [];

  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i];
      const b = ranked[j];
      if (!a.is_court_practice || !b.is_court_practice) continue;
      if (!sameIssue(a, b)) continue;

      const aRank = LEVEL_RANK[a.court_level];
      const bRank = LEVEL_RANK[b.court_level];

      // higher vs lower (different court levels on same issue)
      if (aRank !== bRank) {
        const higher = aRank > bRank ? a : b;
        const lower = aRank > bRank ? b : a;
        lower.conflicting_with_higher_practice = true;
        conflicts.push({
          type: "higher_vs_lower",
          issue: a.legal_issue || b.legal_issue || a.linked_norms[0] || null,
          higher,
          lower,
          sources: [higher.id, lower.id],
          warning: `${lower.court_label} position may conflict with binding ${higher.court_label} practice on the same issue; the higher court controls.`,
          cautious_output_required: true,
        });
      }

      // outdated vs newer (same level, one outdated)
      if (a.outdated !== b.outdated) {
        const older = a.outdated ? a : b;
        const newer = a.outdated ? b : a;
        conflicts.push({
          type: "outdated_vs_newer",
          issue: a.legal_issue || b.legal_issue || a.linked_norms[0] || null,
          newer,
          older,
          sources: [newer.id, older.id],
          warning: `Practice ${older.id} appears outdated/superseded relative to ${newer.id} on the same issue; rely on the newer practice.`,
          cautious_output_required: true,
        });
      }
    }
  }
  return conflicts;
}

/** Controlling Cassation position(s) — highest-weight, non-outdated cassation practice. */
export function detectCassationPosition(
  practices: PracticeSourceLike[],
  ctx: CourtPracticeReasoningContext = {},
): ClassifiedPractice[] {
  return rankCourtPractice(practices, ctx)
    .filter((p) => p.court_level === "cassation_court" && !p.outdated);
}

/** Constitutional Court position(s) — binding for constitutional interpretation. */
export function detectConstitutionalCourtPosition(
  practices: PracticeSourceLike[],
  ctx: CourtPracticeReasoningContext = {},
): ClassifiedPractice[] {
  return rankCourtPractice(practices, { ...ctx, constitutional_issue: true })
    .filter((p) => p.court_level === "constitutional_court" && !p.outdated);
}

/** Build the court_practice metadata block for legal_reasoning. */
export function buildCourtPracticeContext(
  practices: PracticeSourceLike[],
  reasoningContext: CourtPracticeReasoningContext = {},
): CourtPracticeContext {
  const ctx: CourtPracticeReasoningContext = {
    ...reasoningContext,
    constitutional_issue: reasoningContext.constitutional_issue ??
      (reasoningContext.issues?.legal_issues || []).some((i) => /constitution|սահմանադր|конституц/iu.test(String(i))),
    human_rights_issue: reasoningContext.human_rights_issue ??
      ((reasoningContext.issues?.human_rights_issues || []).length > 0),
  };

  const conflicts = detectPracticeConflicts(practices, ctx); // mutates conflict flags on its own copies
  const ranked = rankCourtPractice(practices, ctx);

  // propagate conflict flags from conflict detection onto ranked items by id
  const conflictedLowerIds = new Set(
    conflicts.filter((c) => c.type === "higher_vs_lower" && c.lower).map((c) => c.lower!.id),
  );
  for (const p of ranked) {
    if (conflictedLowerIds.has(p.id)) {
      p.conflicting_with_higher_practice = true;
      if (!p.warnings.includes("conflicts_with_higher_practice")) p.warnings.push("conflicts_with_higher_practice");
    }
  }

  // norm linking from reasoning norm anchors and/or provided norms
  const norms: NormRef[] = [
    ...(reasoningContext.norms || []),
    ...((reasoningContext.retrieval_plan?.norm_anchors || []).map((a) => ({
      article_number: a.article,
      act_name: a.act_name,
      reference: a.raw,
    }))),
  ];
  const linked_norms = norms.length > 0 ? linkPracticeToNorms(practices, norms) : [];

  const warnings = new Set<string>();
  for (const p of ranked) for (const w of p.warnings) warnings.add(w);
  for (const c of conflicts) warnings.add(c.warning);

  return {
    ranked_practice: ranked,
    binding_practice: ranked.filter((p) => p.weight_class === "binding"),
    persuasive_practice: ranked.filter((p) => p.weight_class === "persuasive"),
    weak_practice: ranked.filter((p) => p.weight_class === "weak"),
    echr_practice: ranked.filter((p) => p.court_level === "echr"),
    conflicts,
    linked_norms,
    warnings: [...warnings],
  };
}

export interface PracticeUseValidation {
  allowed: boolean;
  warnings: string[];
  requires_explanation: boolean;
}

/**
 * Validate an intended use of a practice. Aggregator and document generation
 * may only use practice that passes this gate.
 */
export function validatePracticeUse(
  practice: PracticeSourceLike | ClassifiedPractice,
  intendedUse: PracticeUse,
): PracticeUseValidation {
  const cp: ClassifiedPractice = "court_level" in practice && "weight_class" in practice
    ? practice as ClassifiedPractice
    : classifyCourtPractice(practice as PracticeSourceLike);

  const warnings: string[] = [];
  let allowed = true;
  let requires_explanation = false;

  // Venice / non-court practice is never court precedent
  if (!cp.is_court_practice) {
    if (["binding_precedent", "persuasive_support", "document_generation_binding", "override_cassation"].includes(intendedUse)) {
      allowed = false;
      warnings.push("not_court_practice_cannot_be_used_as_precedent");
    }
  }

  // First instance: never a strong/binding precedent (Rule 4)
  if (cp.court_level === "first_instance_court" &&
      ["binding_precedent", "document_generation_binding"].includes(intendedUse)) {
    allowed = false;
    warnings.push("first_instance_cannot_be_binding_precedent");
  }

  // Appellate cannot override Cassation (Rule 3)
  if (cp.court_level === "appellate_court" && intendedUse === "override_cassation") {
    allowed = false;
    warnings.push("appellate_cannot_override_cassation");
  }

  // ECHR cannot replace domestic law without explanation (Rules 5,6)
  if (cp.court_level === "echr" && intendedUse === "replace_domestic_law") {
    allowed = false;
    requires_explanation = true;
    warnings.push("echr_cannot_replace_domestic_law_without_explanation");
  }

  // Constitutional authority requires the Constitutional Court (Rule 1)
  if (intendedUse === "constitutional_authority" && cp.court_level !== "constitutional_court") {
    allowed = false;
    warnings.push("constitutional_authority_requires_constitutional_court");
  }

  // Outdated practice for any binding use (Rule 7)
  if (cp.outdated && ["binding_precedent", "document_generation_binding", "constitutional_authority"].includes(intendedUse)) {
    allowed = false;
    warnings.push("outdated_practice_not_usable_as_binding");
  }

  // Distinguishable facts -> caution (Rule 8), does not block but flags
  if (cp.distinguishable) {
    requires_explanation = true;
    warnings.push("facts_distinguishable_requires_explanation");
  }

  return { allowed, warnings, requires_explanation };
}

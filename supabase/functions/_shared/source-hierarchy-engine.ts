export type SourceAuthorityLevel =
  | "constitution"
  | "international_treaty"
  | "echr"
  | "ecthr_case_law"
  | "constitutional_court"
  | "cassation_court"
  | "code"
  | "statute"
  | "subordinate_normative_act"
  | "government_decision"
  | "municipal_act"
  | "council_of_elders_decision"
  | "administrative_regulation"
  | "lower_court_practice"
  | "venice_commission"
  | "doctrine_reference"
  | "unknown";

export type SourceUse = "binding_law" | "persuasive_authority" | "auxiliary_interpretation" | "factual_background" | "current_law";

export interface LegalSourceLike {
  id?: string;
  document_id?: string;
  chunk_id?: string;
  title?: string;
  category?: string;
  practice_category?: string;
  court_type?: string;
  court_name?: string;
  source_name?: string;
  source_type?: string;
  citation_anchor?: string;
  content_text?: string;
  content_snippet?: string;
  norm_status?: string;
  effective_from?: string | null;
  effective_to?: string | null;
  adopted_at?: string | null;
  amended_at?: string | null;
  decision_date?: string | null;
  version_date?: string | null;
  is_current?: boolean | null;
}

export interface ClassifiedLegalSource extends LegalSourceLike {
  source_level: SourceAuthorityLevel;
  authority_rank: number;
  authority_label: string;
  binding_status: "binding" | "persuasive" | "auxiliary" | "reference" | "unknown";
  confidence: "high" | "medium" | "low";
  hierarchy_warnings: string[];
  temporal_status?: TemporalStatus;
  temporal_warnings?: string[];
  temporal_valid?: boolean;
}

export interface SourceConflict {
  type: string;
  higher_source?: ClassifiedLegalSource;
  lower_source?: ClassifiedLegalSource;
  sources: ClassifiedLegalSource[];
  warning: string;
  cautious_output_required: boolean;
}

export interface LexSpecialisResult {
  general_rule?: ClassifiedLegalSource;
  special_rule?: ClassifiedLegalSource;
  special_rule_reason: string;
  whether_special_rule_controls: boolean;
}

export interface LexPosteriorResult {
  older_rule?: ClassifiedLegalSource;
  later_rule?: ClassifiedLegalSource;
  reason: string;
  whether_later_rule_controls: boolean;
}

export interface SourceHierarchyContext {
  ranked_sources: ClassifiedLegalSource[];
  binding_sources: ClassifiedLegalSource[];
  persuasive_sources: ClassifiedLegalSource[];
  auxiliary_sources: ClassifiedLegalSource[];
  conflicts: SourceConflict[];
  lex_specialis: LexSpecialisResult[];
  lex_posterior: LexPosteriorResult[];
  source_use_warnings: string[];
}

export const LEGAL_SOURCE_LEVELS: Array<{ level: SourceAuthorityLevel; label: string; rank: number }> = [
  { level: "constitution", label: "Constitution of the Republic of Armenia", rank: 1 },
  { level: "international_treaty", label: "International treaties of the Republic of Armenia", rank: 2 },
  { level: "echr", label: "European Convention on Human Rights", rank: 3 },
  { level: "ecthr_case_law", label: "European Court of Human Rights case law", rank: 4 },
  { level: "constitutional_court", label: "Constitutional Court of Armenia decisions", rank: 5 },
  { level: "cassation_court", label: "Court of Cassation of Armenia decisions", rank: 6 },
  { level: "code", label: "Codes of the Republic of Armenia", rank: 7 },
  { level: "statute", label: "Laws of the Republic of Armenia", rank: 8 },
  { level: "subordinate_normative_act", label: "Subordinate normative acts", rank: 9 },
  { level: "government_decision", label: "Government decisions of the Republic of Armenia", rank: 10 },
  { level: "municipal_act", label: "Mayor / municipal acts", rank: 11 },
  { level: "council_of_elders_decision", label: "Council of Elders decisions", rank: 12 },
  { level: "administrative_regulation", label: "Administrative regulations", rank: 13 },
  { level: "lower_court_practice", label: "Lower court practice", rank: 14 },
  { level: "venice_commission", label: "Venice Commission documents", rank: 15 },
  { level: "doctrine_reference", label: "Doctrinal / reference materials", rank: 16 },
  { level: "unknown", label: "Unknown source", rank: 99 },
] as const;

export const SOURCE_AUTHORITY_RANKS: Record<SourceAuthorityLevel, number> = Object.fromEntries(
  LEGAL_SOURCE_LEVELS.map((item) => [item.level, item.rank]),
) as Record<SourceAuthorityLevel, number>;

const SOURCE_LABELS = Object.fromEntries(LEGAL_SOURCE_LEVELS.map((item) => [item.level, item.label])) as Record<SourceAuthorityLevel, string>;

function textOf(source: LegalSourceLike): string {
  return [
    source.title,
    source.category,
    source.practice_category,
    source.court_type,
    source.court_name,
    source.source_name,
    source.source_type,
    source.citation_anchor,
    source.content_text,
    source.content_snippet,
  ].filter(Boolean).join(" ").toLowerCase();
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function bindingStatus(level: SourceAuthorityLevel): ClassifiedLegalSource["binding_status"] {
  if (["constitution", "international_treaty", "echr", "constitutional_court", "cassation_court", "code", "statute", "subordinate_normative_act", "government_decision", "municipal_act", "council_of_elders_decision", "administrative_regulation"].includes(level)) return "binding";
  if (["ecthr_case_law", "lower_court_practice"].includes(level)) return "persuasive";
  if (level === "venice_commission") return "auxiliary";
  if (level === "doctrine_reference") return "reference";
  return "unknown";
}

function confidence(level: SourceAuthorityLevel, source: LegalSourceLike): ClassifiedLegalSource["confidence"] {
  if (level === "unknown") return "low";
  if (source.id || source.document_id || source.chunk_id) return "high";
  return "medium";
}

export function classifyLegalSource(source: LegalSourceLike): ClassifiedLegalSource {
  const text = textOf(source);
  let source_level: SourceAuthorityLevel = "unknown";

  if (has(text, /venice commission|վենետիկ|венециан/iu)) source_level = "venice_commission";
  else if (has(text, /constitution|սահմանադր|конституц/iu) && !has(text, /constitutional court|սահմանադրական դատարան|конституционный суд/iu)) source_level = "constitution";
  else if (has(text, /international treaty|ratified treaty|միջազգային պայմանագիր|международн.*договор/iu)) source_level = "international_treaty";
  else if (has(text, /\bechr\b|european convention|եվրոպական կոնվենց|европейск.*конвенц/iu) && !has(text, /court|case|judgment|practice|դատարան|решени|суд/iu)) source_level = "echr";
  else if (has(text, /ecthr|european court of human rights|\bechr\b.*(?:case|judgment|practice)|մարդու իրավունքների եվրոպական դատարան|еспч/iu)) source_level = "ecthr_case_law";
  else if (has(text, /constitutional court|սահմանադրական դատարան|конституционный суд/iu)) source_level = "constitutional_court";
  else if (has(text, /cassation|վճռաբեկ|кассац/iu)) source_level = "cassation_court";
  else if (has(text, /code|օրենսգիրք|кодекс/iu)) source_level = "code";
  else if (has(text, /government decision|government decree|կառավարության որոշում|постановлен.*правительств/iu)) source_level = "government_decision";
  else if (has(text, /council of elders|ավագանի|совет старейшин/iu)) source_level = "council_of_elders_decision";
  else if (has(text, /municipal|municipality|mayor|համայնք|քաղաքապետ|муниципал|мэр/iu)) source_level = "municipal_act";
  else if (has(text, /administrative regulation|regulation|կանոնակարգ|регламент/iu)) source_level = "administrative_regulation";
  else if (has(text, /subordinate|bylaw|ministerial|ենթաօրենսդրական|подзакон/iu)) source_level = "subordinate_normative_act";
  else if (has(text, /law|statute|օրենք|закон/iu)) source_level = "statute";
  else if (has(text, /first instance|appeal court|lower court|առաջին ատյան|վերաքննիչ|первая инстанц|апелляц/iu)) source_level = "lower_court_practice";
  else if (has(text, /doctrine|commentary|reference|handbook|դոկտրին|մեկնաբան|справоч|доктрин|комментар/iu)) source_level = "doctrine_reference";

  const hierarchy_warnings: string[] = [];
  const status = String(source.norm_status || "").toLowerCase();
  if (source.is_current === false || ["repealed", "inactive", "expired", "superseded", "not_current"].includes(status)) {
    hierarchy_warnings.push("source_not_current");
  }
  if (source.effective_to) hierarchy_warnings.push("source_has_effective_to");
  if (source_level === "venice_commission") hierarchy_warnings.push("venice_auxiliary_only");
  if (source_level === "unknown") hierarchy_warnings.push("unknown_source_low_confidence");

  return {
    ...source,
    source_level,
    authority_rank: SOURCE_AUTHORITY_RANKS[source_level],
    authority_label: SOURCE_LABELS[source_level],
    binding_status: bindingStatus(source_level),
    confidence: confidence(source_level, source),
    hierarchy_warnings,
    temporal_status: classifyTemporalStatus(source),
  };
}

export function rankLegalSources(sources: LegalSourceLike[]): ClassifiedLegalSource[] {
  return sources
    .map(classifyLegalSource)
    .sort((a, b) => a.authority_rank - b.authority_rank || String(a.title || "").localeCompare(String(b.title || "")));
}

function sourceKey(source: ClassifiedLegalSource): string {
  return String(source.document_id || source.id || source.title || source.source_level);
}

function conflictPair(
  type: string,
  higher: ClassifiedLegalSource,
  lower: ClassifiedLegalSource,
  warning: string,
): SourceConflict {
  return { type, higher_source: higher, lower_source: lower, sources: [higher, lower], warning, cautious_output_required: true };
}

export function detectSourceConflicts(sources: LegalSourceLike[]): SourceConflict[] {
  const ranked = rankLegalSources(sources);
  const conflicts: SourceConflict[] = [];
  const byLevel = new Map<SourceAuthorityLevel, ClassifiedLegalSource[]>();
  for (const source of ranked) {
    const current = byLevel.get(source.source_level) || [];
    current.push(source);
    byLevel.set(source.source_level, current);
  }

  for (const municipal of [...(byLevel.get("municipal_act") || []), ...(byLevel.get("council_of_elders_decision") || [])]) {
    const higher = ranked.find((s) => ["constitution", "international_treaty", "echr", "code", "statute", "government_decision"].includes(s.source_level));
    if (higher) conflicts.push(conflictPair("municipal_conflict_with_higher_law", higher, municipal, "Municipal source cannot override statute, code, Constitution, treaty, ECHR, or Government decision."));
  }
  for (const lowerCourt of byLevel.get("lower_court_practice") || []) {
    const cassation = ranked.find((s) => s.source_level === "cassation_court");
    if (cassation) conflicts.push(conflictPair("lower_court_conflict_with_cassation", cassation, lowerCourt, "Lower court practice cannot overcome Court of Cassation position."));
  }
  for (const subordinate of [...(byLevel.get("subordinate_normative_act") || []), ...(byLevel.get("government_decision") || [])]) {
    const statute = ranked.find((s) => ["code", "statute"].includes(s.source_level));
    if (statute) conflicts.push(conflictPair("subordinate_conflict_with_statute", statute, subordinate, "Subordinate or Government act cannot contradict code/statute."));
  }
  for (const source of ranked) {
    if (source.source_level === "unknown") {
      conflicts.push({ type: "unknown_source", sources: [source], warning: "Unknown source has low authority confidence; cautious output required.", cautious_output_required: true });
    }
    if (source.hierarchy_warnings.includes("source_not_current")) {
      conflicts.push({ type: "inactive_source", sources: [source], warning: "Repealed/inactive source cannot be used as current law.", cautious_output_required: true });
    }
  }
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = `${conflict.type}:${conflict.sources.map(sourceKey).join(":")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function specificityScore(source: ClassifiedLegalSource, issues: string[]): number {
  const text = textOf(source);
  let score = 0;
  if (/special|specific|հատուկ|специальн/iu.test(text)) score += 6;
  if (/general|ընդհանուր|общ/iu.test(text)) score -= 3;
  for (const issue of issues) {
    const words = issue.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 8);
    for (const word of words) if (text.includes(word)) score += 1;
  }
  return score;
}

export function applyLexSpecialis(sources: LegalSourceLike[], issues: string[] = []): LexSpecialisResult[] {
  const ranked = rankLegalSources(sources);
  const results: LexSpecialisResult[] = [];
  for (const general of ranked) {
    for (const special of ranked) {
      if (sourceKey(general) === sourceKey(special)) continue;
      if (general.authority_rank !== special.authority_rank) continue;
      const generalScore = specificityScore(general, issues);
      const specialScore = specificityScore(special, issues);
      if (specialScore > generalScore + 2) {
        results.push({
          general_rule: general,
          special_rule: special,
          special_rule_reason: "Same-level source is more specific to the stated legal issues.",
          whether_special_rule_controls: true,
        });
      }
    }
  }
  return results.slice(0, 10);
}

function dateValue(source: ClassifiedLegalSource): number {
  const raw = source.amended_at || source.adopted_at || source.effective_from || source.decision_date || source.version_date || "";
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

export function applyLexPosterior(sources: LegalSourceLike[], _temporalContext: Record<string, unknown> = {}): LexPosteriorResult[] {
  const ranked = rankLegalSources(sources);
  const results: LexPosteriorResult[] = [];
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i];
      const b = ranked[j];
      if (a.authority_rank !== b.authority_rank) continue;
      const aDate = dateValue(a);
      const bDate = dateValue(b);
      if (!aDate || !bDate || aDate === bDate) continue;
      const later = aDate > bDate ? a : b;
      const older = aDate > bDate ? b : a;
      if (later.hierarchy_warnings.includes("source_not_current")) continue;
      results.push({
        older_rule: older,
        later_rule: later,
        reason: "Same-level sources conflict temporally; later current rule controls within its effective scope.",
        whether_later_rule_controls: true,
      });
    }
  }
  return results.slice(0, 10);
}

export function validateSourceUse(source: LegalSourceLike, intendedUse: SourceUse | string): { allowed: boolean; warnings: string[] } {
  const classified = classifyLegalSource(source);
  const warnings = [...classified.hierarchy_warnings];
  const temporalStatus = classifyTemporalStatus(source, (source as { referenceDate?: unknown }).referenceDate);
  const use = String(intendedUse);
  if (classified.source_level === "venice_commission" && use === "binding_law") warnings.push("venice_commission_cannot_be_binding");
  if (classified.source_level === "lower_court_practice" && use === "binding_law") warnings.push("lower_court_practice_cannot_override_cassation");
  if (classified.source_level === "municipal_act" && ["binding_law", "current_law"].includes(use)) warnings.push("municipal_act_must_not_override_statute_or_government_decision");
  if (classified.hierarchy_warnings.includes("source_not_current") && use === "current_law") warnings.push("inactive_source_cannot_be_current_law");
  if (classified.source_level === "ecthr_case_law" && use === "binding_law") warnings.push("echr_requires_domestic_law_explanation");
  const temporalWarningAcknowledged = (source as { temporal_warning_acknowledged?: unknown }).temporal_warning_acknowledged === true;
  if ((source.effective_to || source.version_date) && !temporalWarningAcknowledged) warnings.push("old_revision_requires_temporal_warning");
  if (["repealed", "expired", "not_yet_effective", "conflicting_revision"].includes(temporalStatus) && ["binding_law", "current_law"].includes(use)) {
    warnings.push(`temporal_invalid_for_${use}`);
  }
  return {
    allowed: warnings.length === classified.hierarchy_warnings.length,
    warnings,
  };
}

export function buildSourceHierarchyContext(
  sources: LegalSourceLike[],
  reasoningContext: { issues?: Record<string, string[]>; temporal_context?: Record<string, unknown> } | null = null,
): SourceHierarchyContext {
  const referenceDate = reasoningContext?.temporal_context?.effective_at as string | null | undefined;
  const temporalSources = applyTemporalValidation(sources, referenceDate);
  const ranked_sources = rankLegalSources(temporalSources).map((source) => {
    const match = temporalSources.find((s) =>
      (s.chunk_id && s.chunk_id === source.chunk_id) ||
      (s.document_id && s.document_id === source.document_id) ||
      (s.id && s.id === source.id)
    );
    return {
      ...source,
      temporal_status: match?.temporal_status,
      temporal_warnings: match?.temporal_warnings,
      temporal_valid: match?.temporal_valid,
      hierarchy_warnings: [...new Set([...source.hierarchy_warnings, ...(match?.temporal_warnings || [])])],
    };
  });
  const issueList = Object.values(reasoningContext?.issues || {}).flat().filter((item): item is string => typeof item === "string");
  const conflicts = detectSourceConflicts(ranked_sources);
  const lex_specialis = applyLexSpecialis(ranked_sources, issueList);
  const lex_posterior = applyLexPosterior(ranked_sources, reasoningContext?.temporal_context || {});
  const source_use_warnings = [
    ...ranked_sources.flatMap((source) => source.hierarchy_warnings),
    ...conflicts.map((conflict) => conflict.warning),
  ];
  return {
    ranked_sources,
    binding_sources: ranked_sources.filter((s) => s.binding_status === "binding"),
    persuasive_sources: ranked_sources.filter((s) => s.binding_status === "persuasive"),
    auxiliary_sources: ranked_sources.filter((s) => s.binding_status === "auxiliary"),
    conflicts,
    lex_specialis,
    lex_posterior,
    source_use_warnings: [...new Set(source_use_warnings)],
  };
}
import { applyTemporalValidation, classifyTemporalStatus, type TemporalStatus } from "./temporal-validity-engine.ts";

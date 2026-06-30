export type TemporalStatus =
  | "current_valid"
  | "historically_valid"
  | "not_yet_effective"
  | "expired"
  | "repealed"
  | "unknown_effective_date"
  | "missing_reference_date"
  | "conflicting_revision";

export interface TemporalSourceLike {
  id?: string;
  document_id?: string;
  chunk_id?: string;
  title?: string;
  norm_status?: string | null;
  normalized_status?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  adopted_at?: string | null;
  amended_at?: string | null;
  version_date?: string | null;
  decision_date?: string | null;
  is_current?: boolean | null;
  citation_anchor?: string | null;
  source_level?: string;
}

export interface TemporalValidation extends TemporalSourceLike {
  temporal_status: TemporalStatus;
  temporal_warnings: string[];
  temporal_valid: boolean;
  usable_as_current_law: boolean;
  historical_revision: boolean;
}

export function normalizeEffectiveDate(input: unknown): string | null {
  if (input === null || typeof input === "undefined") return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input.toISOString().substring(0, 10);
  const raw = String(input).trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dotted) {
    const dd = dotted[1].padStart(2, "0");
    const mm = dotted[2].padStart(2, "0");
    return `${dotted[3]}-${mm}-${dd}`;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().substring(0, 10) : null;
}

export function buildTemporalFilter(referenceDate: unknown) {
  const effective_at = normalizeEffectiveDate(referenceDate);
  return {
    effective_at,
    sql: [
      "(norm_status IS NULL OR norm_status = 'active')",
      "(p_effective_at IS NULL OR effective_from IS NULL OR effective_from <= p_effective_at)",
      "(p_effective_at IS NULL OR effective_to IS NULL OR effective_to > p_effective_at)",
    ].join("\nAND "),
    warnings: effective_at ? [] : ["effective_date_missing"],
  };
}

function dateMs(value?: string | null): number | null {
  if (!value) return null;
  const normalized = normalizeEffectiveDate(value);
  if (!normalized) return null;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function sourceKey(source: TemporalSourceLike): string {
  return String(source.document_id || source.id || source.citation_anchor || source.title || "");
}

function normStatus(source: TemporalSourceLike): string {
  return String(source.norm_status || source.normalized_status || "").toLowerCase();
}

export function classifyTemporalStatus(source: TemporalSourceLike, referenceDate?: unknown): TemporalStatus {
  const ref = normalizeEffectiveDate(referenceDate);
  const status = normStatus(source);
  if (["repealed", "inactive", "expired", "superseded", "not_current"].includes(status)) return "repealed";
  if (!ref) return "missing_reference_date";

  const refMs = dateMs(ref)!;
  const fromMs = dateMs(source.effective_from);
  const toMs = dateMs(source.effective_to);
  if (fromMs !== null && fromMs > refMs) return "not_yet_effective";
  if (toMs !== null && toMs <= refMs) return "expired";
  if (fromMs === null && toMs === null) return "unknown_effective_date";
  if (source.is_current === false) return "historically_valid";
  return "current_valid";
}

export function validateTemporalSource(source: TemporalSourceLike, referenceDate?: unknown): TemporalValidation {
  const temporal_status = classifyTemporalStatus(source, referenceDate);
  const warnings: string[] = [];
  if (temporal_status === "missing_reference_date") warnings.push("effective_date_missing");
  if (temporal_status === "unknown_effective_date") warnings.push("source_effective_date_unknown");
  if (temporal_status === "not_yet_effective") warnings.push("source_not_yet_effective_for_reference_date");
  if (temporal_status === "expired") warnings.push("source_expired_for_reference_date");
  if (temporal_status === "repealed") warnings.push("source_repealed_or_inactive");
  if (temporal_status === "historically_valid") warnings.push("historical_revision");

  const temporal_valid = ["current_valid", "historically_valid", "unknown_effective_date", "missing_reference_date"].includes(temporal_status);
  return {
    ...source,
    temporal_status,
    temporal_warnings: warnings,
    temporal_valid,
    usable_as_current_law: temporal_status === "current_valid" || (temporal_status === "missing_reference_date" && source.is_current !== false),
    historical_revision: temporal_status === "historically_valid",
  };
}

export function buildTemporalWarnings(sources: TemporalSourceLike[], referenceDate?: unknown): string[] {
  const warnings = new Set<string>();
  if (!normalizeEffectiveDate(referenceDate)) warnings.add("effective_date_missing");
  for (const item of applyTemporalValidation(sources, referenceDate)) {
    for (const warning of item.temporal_warnings) warnings.add(warning);
  }
  return [...warnings];
}

export function applyTemporalValidation<T extends TemporalSourceLike>(sources: T[], referenceDate?: unknown): Array<T & TemporalValidation> {
  const validated = sources.map((source) => ({ ...source, ...validateTemporalSource(source, referenceDate) })) as Array<T & TemporalValidation>;
  const groups = new Map<string, Array<T & TemporalValidation>>();
  for (const source of validated) {
    const key = sourceKey(source);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(source);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const validCount = group.filter((s) => s.temporal_valid && !["expired", "not_yet_effective", "repealed"].includes(s.temporal_status)).length;
    if (validCount > 1) {
      for (const source of group) {
        source.temporal_status = "conflicting_revision";
        source.temporal_valid = false;
        source.usable_as_current_law = false;
        source.temporal_warnings = [...new Set([...source.temporal_warnings, "conflicting_revision"])];
      }
    }
  }
  return validated;
}

export function requireTemporalCaution(
  reasoningContext: { normalized_input?: { effective_at?: string | null }; temporal_context?: { effective_at?: string | null; temporal_warnings?: string[] } } | null,
  sources: TemporalSourceLike[],
): boolean {
  const referenceDate = reasoningContext?.normalized_input?.effective_at || reasoningContext?.temporal_context?.effective_at || null;
  if (!normalizeEffectiveDate(referenceDate)) return true;
  const statuses = applyTemporalValidation(sources, referenceDate).map((s) => s.temporal_status);
  return statuses.some((status) => !["current_valid", "historically_valid"].includes(status));
}

export function buildTemporalContextForPrompt(
  reasoningContext: { normalized_input?: { effective_at?: string | null }; temporal_context?: Record<string, unknown> } | null,
  sources: TemporalSourceLike[],
) {
  const referenceDate = reasoningContext?.normalized_input?.effective_at ||
    (reasoningContext?.temporal_context?.effective_at as string | null | undefined) ||
    null;
  const validated_sources = applyTemporalValidation(sources, referenceDate);
  const temporal_warnings = buildTemporalWarnings(sources, referenceDate);
  return {
    effective_at: normalizeEffectiveDate(referenceDate),
    temporal_warnings,
    cautious_output_required: requireTemporalCaution(reasoningContext, sources),
    validated_sources,
    rule: "Use only the source version valid on effective_at; if effective_at is missing, use current revision with caution.",
  };
}

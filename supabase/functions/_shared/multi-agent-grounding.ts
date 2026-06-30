import { extractNormRefs, type NormAnchor } from "./norm-ref-extractor.ts";
import {
  searchKB,
  searchPractice,
  lookupByAnchors,
  formatKBContext,
  formatPracticeContext,
  temporalDisclaimer,
  type AnchorSource,
} from "./rag-search.ts";
import type { KBSearchResult, PracticeSearchResult } from "./rag-types.ts";
import type { VerifiedCitation } from "./citation-verifier.ts";
import { buildReasoningSearchQuery, runLegalReasoningEngine, type LegalReasoningOutput } from "./legal-reasoning-engine.ts";
import { buildSourceHierarchyContext } from "./source-hierarchy-engine.ts";
import { buildCourtPracticeContext } from "./court-practice-engine.ts";
import { buildTemporalContextForPrompt } from "./temporal-validity-engine.ts";

export const INSUFFICIENT_LEGAL_GROUNDING = "INSUFFICIENT_LEGAL_GROUNDING";

type SupabaseClient = {
  from: (table: string) => unknown;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export interface GroundingInput {
  supabase: SupabaseClient;
  supabaseUrl: string;
  supabaseKey: string;
  agentType: string;
  mode: "single_file" | "synthesis" | "agent_run" | "aggregator";
  caseType?: string | null;
  caseTitle?: string | null;
  caseNumber?: string | null;
  factsText: string;
  legalQuestion?: string | null;
  referenceDate?: string | null;
  previousRuns?: Array<Record<string, unknown>>;
}

export interface GroundingResult {
  ok: boolean;
  mode: GroundingInput["mode"];
  agentType: string;
  extracted_issues: string[];
  norm_anchors: NormAnchor[];
  legal_sources: {
    anchor: AnchorSource[];
    arlis: KBSearchResult[];
    case_law: PracticeSearchResult[];
    echr: PracticeSearchResult[];
    venice: KBSearchResult[];
  };
  citation_metadata: Array<Record<string, unknown>>;
  allowed_citation_ids: string[];
  temporal_warnings: string[];
  retrieval_routes: string[];
  legal_reasoning: LegalReasoningOutput;
  stop_code?: typeof INSUFFICIENT_LEGAL_GROUNDING;
}

const LEGAL_AGENT_TYPES = new Set([
  "evidence_admissibility",
  "charge_qualification",
  "procedural_violations",
  "substantive_violations",
  "defense_strategy",
  "prosecution_weaknesses",
  "rights_violations",
  "aggregator",
]);

export function requiresLegalGrounding(agentType: string): boolean {
  return LEGAL_AGENT_TYPES.has(agentType) || agentType !== "evidence_collector";
}

export function extractLegalIssues(text: string, caseType?: string | null): string[] {
  const lower = text.toLowerCase();
  const issues: string[] = [];
  const add = (label: string, patterns: RegExp[]) => {
    if (patterns.some((re) => re.test(lower))) issues.push(label);
  };

  add("evidence_admissibility", [/admissib/i, /թույլատրելի/u, /допустим/u, /ապացույց/u]);
  add("procedural_violation", [/procedure/i, /դատավար/u, /ընթացակարգ/u, /процедур/u, /ժամկետ/u]);
  add("qualification", [/qualification/i, /որակ/u, /квалифика/u, /մեղադր/u]);
  add("substantive_law", [/substantive/i, /նյութական/u, /граждан/u, /քրեական/u]);
  add("echr_rights", [/echr/i, /european convention/i, /կոնվենց/u, /մարդու իրավունք/u, /едсп/i]);
  add("constitutional", [/constitution/i, /սահմանադր/u, /конституц/u]);
  add("venice", [/venice/i, /վենետիկ/u, /венециан/u]);

  if (caseType && !issues.includes(caseType)) issues.unshift(caseType);
  if (issues.length === 0 && text.trim()) issues.push(text.trim().slice(0, 180));
  return [...new Set(issues)].slice(0, 8);
}

function relevantToEchr(text: string, caseType?: string | null): boolean {
  return caseType === "echr" || /echr|european convention|կոնվենց|մարդու իրավունք|едсп/i.test(text);
}

function relevantToVenice(text: string): boolean {
  return /venice|վենետիկ|венециан|constitutional reform|սահմանադրական բարեփոխ/i.test(text);
}

function uniqIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter(Boolean).map((id) => String(id).toLowerCase()))];
}

function sourceMeta(source: Record<string, unknown>, sourceType: string): Record<string, unknown> {
  return {
    source_type: sourceType,
    document_id: source.id || source.document_id,
    chunk_id: source.chunk_id,
    title: source.title,
    category: source.category || source.practice_category,
    citation_anchor: source.citation_anchor,
    norm_status: source.norm_status,
    effective_from: source.effective_from,
    effective_to: source.effective_to,
  };
}

export function extractVerifiedCitationsFromRuns(previousRuns: Array<Record<string, unknown>> = []): VerifiedCitation[] {
  const out: VerifiedCitation[] = [];
  for (const run of previousRuns) {
    const candidates = [
      run.verified_citations,
      (run.sources_used && Array.isArray(run.sources_used)) ? run.sources_used : undefined,
    ];
    if (typeof run.analysis_result === "string") {
      try {
        const parsed = JSON.parse(run.analysis_result);
        candidates.push(parsed.verified_citations, parsed.validation?.verified_citations);
      } catch {
        // ignore non-JSON legacy text
      }
    }
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      for (const item of candidate) {
        if (item && typeof item === "object" && (item as Record<string, unknown>).status === "verified") {
          out.push(item as VerifiedCitation);
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.document_id || ""}:${c.chunk_id || ""}`;
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runPreAnalysisGrounding(input: GroundingInput): Promise<GroundingResult> {
  const facts = [input.caseTitle, input.caseNumber, input.factsText, input.legalQuestion]
    .filter(Boolean)
    .join("\n");
  const legal_reasoning = runLegalReasoningEngine({
    user_query: input.legalQuestion || "",
    case_text: [input.caseTitle, input.caseNumber, input.factsText].filter(Boolean).join("\n"),
    case_type: input.caseType || input.agentType,
    jurisdiction: "Republic of Armenia",
    language: "hy",
    effective_at: input.referenceDate || null,
    function_context: `multi-agent-analyze:${input.mode}:${input.agentType}`,
  });
  const extracted_issues = [...new Set([
    ...extractLegalIssues(facts, input.caseType),
    ...legal_reasoning.issues.legal_issues,
    ...legal_reasoning.issues.procedural_issues,
    ...legal_reasoning.issues.evidentiary_issues,
    ...legal_reasoning.issues.human_rights_issues,
  ])].slice(0, 12);
  const norm_anchors = (legal_reasoning.retrieval_plan.norm_anchors.length > 0
    ? legal_reasoning.retrieval_plan.norm_anchors
    : extractNormRefs(facts)).slice(0, 30);
  const temporal_warnings = input.referenceDate
    ? []
    : ["reference_date_missing: retrieval may use current or mixed temporal versions"];

  if (input.agentType === "aggregator") {
    const verified = extractVerifiedCitationsFromRuns(input.previousRuns);
    const allowed = uniqIds(verified.flatMap((c) => [c.document_id, c.chunk_id]));
    return {
      ok: verified.length > 0,
      mode: "aggregator",
      agentType: input.agentType,
      extracted_issues,
      norm_anchors,
      legal_sources: { anchor: [], arlis: [], case_law: [], echr: [], venice: [] },
      citation_metadata: verified as unknown as Array<Record<string, unknown>>,
      allowed_citation_ids: allowed,
      temporal_warnings,
      retrieval_routes: ["agent_verified_citations_only"],
      legal_reasoning,
      stop_code: verified.length > 0 ? undefined : INSUFFICIENT_LEGAL_GROUNDING,
    };
  }

  const query = buildReasoningSearchQuery(legal_reasoning, [facts, extracted_issues.join(" "), norm_anchors.map((a) => a.raw).join(" ")]
    .join("\n")
    .trim()
    .slice(0, 2000));

  const [anchor, arlis, caseLaw, echr, venice] = await Promise.all([
    lookupByAnchors({
      anchors: norm_anchors,
      caseType: input.caseType,
      referenceDate: input.referenceDate || null,
      supabase: input.supabase,
    }),
    searchKB({
      supabase: input.supabase,
      supabaseUrl: input.supabaseUrl,
      supabaseKey: input.supabaseKey,
      query: query || facts || "ՀՀ օրենք",
      referenceDate: input.referenceDate || null,
      limit: 6,
      snippetLength: 2500,
    }),
    searchPractice({
      supabase: input.supabase,
      supabaseUrl: input.supabaseUrl,
      supabaseKey: input.supabaseKey,
      query: query || facts || "դատական պրակտիկա",
      referenceDate: input.referenceDate || null,
      limit: 4,
    }),
    (relevantToEchr(facts, input.caseType) || legal_reasoning.reasoning_checklist.echr_check_required)
      ? searchPractice({
        supabase: input.supabase,
        supabaseUrl: input.supabaseUrl,
        supabaseKey: input.supabaseKey,
        query: `${query}\nECHR European Convention ՄԻԵԴ`,
        referenceDate: input.referenceDate || null,
        limit: 4,
      })
      : Promise.resolve({ results: [], retrieval_mode: "keyword_only" as const, semantic_ok: false, sources: [] }),
    (relevantToVenice(facts) || legal_reasoning.reasoning_checklist.venice_check_required)
      ? searchKB({
        supabase: input.supabase,
        supabaseUrl: input.supabaseUrl,
        supabaseKey: input.supabaseKey,
        query: `${query}\nVenice Commission Վենետիկի հանձնաժողով`,
        referenceDate: input.referenceDate || null,
        limit: 3,
        snippetLength: 2000,
      })
      : Promise.resolve({ results: [], retrieval_mode: "keyword_only" as const, semantic_ok: false, sources: [] }),
  ]);

  const arlisResults = arlis.results;
  const caseLawResults = caseLaw.results;
  const echrResults = echr.results;
  const veniceResults = venice.results;
  const allowed_citation_ids = uniqIds([
    ...anchor.flatMap((s) => [s.id, s.document_id, s.chunk_id]),
    ...arlisResults.flatMap((s) => [s.id, s.document_id, s.chunk_id]),
    ...caseLawResults.flatMap((s) => [s.id, s.document_id, s.chunk_id]),
    ...echrResults.flatMap((s) => [s.id, s.document_id, s.chunk_id]),
    ...veniceResults.flatMap((s) => [s.id, s.document_id, s.chunk_id]),
  ]);

  const citation_metadata = [
    ...anchor.map((s) => sourceMeta(s as unknown as Record<string, unknown>, "anchor")),
    ...arlisResults.map((s) => sourceMeta(s as unknown as Record<string, unknown>, "arlis")),
    ...caseLawResults.map((s) => sourceMeta(s as unknown as Record<string, unknown>, "case_law")),
    ...echrResults.map((s) => sourceMeta(s as unknown as Record<string, unknown>, "echr")),
    ...veniceResults.map((s) => sourceMeta(s as unknown as Record<string, unknown>, "venice")),
  ];
  legal_reasoning.source_hierarchy = buildSourceHierarchyContext([
    ...anchor,
    ...arlisResults,
    ...caseLawResults,
    ...echrResults,
    ...veniceResults,
  ], legal_reasoning);
  legal_reasoning.temporal_validation = buildTemporalContextForPrompt(legal_reasoning, [
    ...anchor,
    ...arlisResults,
    ...caseLawResults,
    ...echrResults,
    ...veniceResults,
  ]);
  // Court Practice Engine: classify judicial practice (case-law + ECHR + Venice) by weight.
  legal_reasoning.court_practice = buildCourtPracticeContext(
    [...caseLawResults, ...echrResults, ...veniceResults],
    legal_reasoning,
  );
  if (legal_reasoning.court_practice.conflicts.length > 0) {
    legal_reasoning.risk_flags = [...new Set([...legal_reasoning.risk_flags, "court_practice_conflict_warning"])];
    legal_reasoning.reasoning_checklist.cautious_output_required = true;
  }
  if (legal_reasoning.source_hierarchy.conflicts.length > 0) {
    legal_reasoning.risk_flags = [...new Set([...legal_reasoning.risk_flags, "source_conflict_warning"])];
    legal_reasoning.reasoning_checklist.cautious_output_required = true;
  }

  const ok = allowed_citation_ids.length > 0;
  return {
    ok,
    mode: input.mode,
    agentType: input.agentType,
    extracted_issues,
    norm_anchors,
    legal_sources: {
      anchor,
      arlis: arlisResults,
      case_law: caseLawResults,
      echr: echrResults,
      venice: veniceResults,
    },
    citation_metadata,
    allowed_citation_ids,
    temporal_warnings,
    legal_reasoning,
    retrieval_routes: [
      `arlis:${arlis.retrieval_mode || "unknown"}`,
      `case_law:${caseLaw.retrieval_mode || "unknown"}`,
      ...(echrResults.length ? [`echr:${echr.retrieval_mode || "unknown"}`] : []),
      ...(veniceResults.length ? [`venice:${venice.retrieval_mode || "unknown"}`] : []),
      ...(anchor.length ? ["anchor_lookup"] : []),
    ],
    stop_code: ok ? undefined : INSUFFICIENT_LEGAL_GROUNDING,
  };
}

export function buildGroundingBlock(grounding: GroundingResult, factsText: string): string {
  const lines: string[] = [];
  lines.push("\n=== MANDATORY_PRE_ANALYSIS_GROUNDING ===");
  lines.push(`grounding_ok: ${grounding.ok}`);
  lines.push(`mode: ${grounding.mode}`);
  lines.push(`agentType: ${grounding.agentType}`);
  lines.push(`allowed_citation_ids: ${JSON.stringify(grounding.allowed_citation_ids)}`);
  lines.push(`extracted_issues: ${JSON.stringify(grounding.extracted_issues)}`);
  lines.push(`norm_anchors: ${JSON.stringify(grounding.norm_anchors)}`);
  lines.push(`temporal_warnings: ${JSON.stringify(grounding.temporal_warnings)}`);
  lines.push(`legal_reasoning_engine: ${JSON.stringify(grounding.legal_reasoning)}`);
  lines.push(`citation_metadata: ${JSON.stringify(grounding.citation_metadata)}`);
  lines.push("\nUSER_FACTS_FOR_ANALYSIS:");
  lines.push(factsText.slice(0, 6000));

  if (grounding.agentType === "aggregator") {
    lines.push("\nAGGREGATOR VERIFIED CITATIONS ONLY:");
    lines.push(JSON.stringify(grounding.citation_metadata, null, 2));
    lines.push("Aggregator MUST NOT create new citations or cite sources absent from this list.");
  } else {
    if (grounding.legal_sources.anchor.length > 0) {
      lines.push("\nANCHOR_SOURCES:");
      for (const src of grounding.legal_sources.anchor) {
        lines.push(`Title: ${src.title}\nID: ${src.id}${src.chunk_id ? `\nChunkID: ${src.chunk_id}` : ""}\nArticle: ${src.article_number || ""}\n${src.content_text}`);
      }
    }
    if (grounding.legal_sources.arlis.length > 0) {
      lines.push("\nARLIS / KNOWLEDGE SOURCES:");
      lines.push(formatKBContext(grounding.legal_sources.arlis, 2500));
    }
    if (grounding.legal_sources.case_law.length > 0) {
      lines.push("\nCASE LAW SOURCES:");
      lines.push(formatPracticeContext(grounding.legal_sources.case_law, true));
    }
    if (grounding.legal_sources.echr.length > 0) {
      lines.push("\nECHR SOURCES:");
      lines.push(formatPracticeContext(grounding.legal_sources.echr, true));
    }
    if (grounding.legal_sources.venice.length > 0) {
      lines.push("\nVENICE SOURCES:");
      lines.push(formatKBContext(grounding.legal_sources.venice, 2000));
    }
  }

  lines.push(temporalDisclaimer(grounding.temporal_warnings.length ? null : "provided", grounding.temporal_warnings.length > 0));
  lines.push("RULE: No legal conclusion may be made unless tied to the retrieved sources above. If grounding is insufficient, return INSUFFICIENT_LEGAL_GROUNDING.");
  lines.push("=== END_MANDATORY_PRE_ANALYSIS_GROUNDING ===\n");
  return lines.join("\n");
}


export function buildGroundingStopResponse(
  grounding: GroundingResult,
  message = "No retrieved legal sources available for mandatory grounding.",
): Record<string, unknown> {
  return {
    stop_code: INSUFFICIENT_LEGAL_GROUNDING,
    error: INSUFFICIENT_LEGAL_GROUNDING,
    message,
    analysis: message,
    grounding_ok: grounding.ok,
    extracted_issues: grounding.extracted_issues,
    norm_anchors: grounding.norm_anchors,
    allowed_citation_ids: grounding.allowed_citation_ids,
    temporal_warnings: grounding.temporal_warnings,
  };
}

export function findCitationsOutsideGrounding(citedIds: string[], grounding: GroundingResult): string[] {
  const allowed = new Set(grounding.allowed_citation_ids.map((id) => id.toLowerCase()));
  return [...new Set(citedIds.map((id) => id.toLowerCase()).filter((id) => !allowed.has(id)))];
}

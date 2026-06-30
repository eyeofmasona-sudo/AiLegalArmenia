import { extractNormRefs, type NormAnchor } from "./norm-ref-extractor.ts";
import { buildSourceHierarchyContext, type LegalSourceLike, type SourceHierarchyContext } from "./source-hierarchy-engine.ts";
import { buildTemporalContextForPrompt } from "./temporal-validity-engine.ts";
import type { CourtPracticeContext } from "./court-practice-engine.ts";

export type LegalDomain =
  | "constitutional"
  | "civil"
  | "criminal"
  | "administrative"
  | "procedural"
  | "municipal"
  | "human_rights"
  | "international"
  | "mixed";

export type ProceduralStage =
  | "pre-trial"
  | "first_instance"
  | "appeal"
  | "cassation"
  | "constitutional_review"
  | "echr_application"
  | "enforcement"
  | "unknown";

export interface LegalReasoningInput {
  user_query?: string | null;
  case_text?: string | null;
  uploaded_document_text?: string | null;
  case_type?: string | null;
  jurisdiction?: string | null;
  language?: string | null;
  effective_at?: string | null;
  function_context?: string | null;
  retrieved_sources?: LegalSourceLike[];
}

export interface LegalReasoningOutput {
  normalized_input: {
    user_query: string;
    case_text: string;
    uploaded_document_text: string;
    case_type: string;
    jurisdiction: string;
    language: string;
    effective_at: string | null;
    function_context: string;
  };
  facts: {
    confirmed_facts: string[];
    party_assertions: string[];
    disputed_facts: string[];
    missing_facts: string[];
    dates: string[];
    amounts: string[];
    parties: string[];
    authorities: string[];
    documents: string[];
  };
  issues: {
    legal_issues: string[];
    procedural_issues: string[];
    evidentiary_issues: string[];
    human_rights_issues: string[];
    municipal_or_administrative_issues: string[];
    international_law_issues: string[];
  };
  domains: LegalDomain[];
  procedural_stage: ProceduralStage;
  temporal_context: {
    event_dates: string[];
    decision_dates: string[];
    filing_deadlines: string[];
    effective_at: string | null;
    temporal_warnings: string[];
    law_version_needed: "current" | "historical" | "mixed_or_unknown";
  };
  retrieval_plan: {
    required_sources: string[];
    preferred_sources: string[];
    source_domains: string[];
    search_queries: string[];
    norm_anchors: NormAnchor[];
    case_law_queries: string[];
    echr_queries: string[];
    venice_queries: string[];
    municipal_queries: string[];
  };
  source_hierarchy_plan: {
    primary_sources: string[];
    secondary_sources: string[];
    auxiliary_sources: string[];
    binding_sources: string[];
    persuasive_sources: string[];
    prohibited_as_binding: string[];
  };
  reasoning_checklist: {
    lex_specialis_required: boolean;
    lex_posterior_required: boolean;
    constitutional_check_required: boolean;
    echr_check_required: boolean;
    venice_check_required: boolean;
    evidence_analysis_required: boolean;
    deadline_check_required: boolean;
    procedural_violation_check_required: boolean;
    citation_verification_required: boolean;
    cautious_output_required: boolean;
  };
  temporal_validation: ReturnType<typeof buildTemporalContextForPrompt>;
  source_hierarchy: SourceHierarchyContext;
  /** Court Practice Engine output (judicial practice classified by weight/applicability). */
  court_practice?: CourtPracticeContext;
  risk_flags: string[];
  stop_reasons: string[];
  warnings: string[];
}

const SOURCE_HIERARCHY = {
  primary_sources: [
    "RA Constitution",
    "RA ratified international treaties",
    "ECHR",
    "RA Constitutional Court decisions",
    "RA Court of Cassation decisions",
    "RA codes",
    "RA laws",
    "RA subordinate normative acts",
    "RA Government decisions",
    "municipal decisions",
    "administrative regulations",
  ],
  secondary_sources: [
    "RA lower-court practice where retrieved and relevant",
    "legal summaries only when tied to primary sources",
  ],
  auxiliary_sources: [
    "Venice Commission documents",
  ],
  binding_sources: [
    "RA Constitution",
    "RA ratified international treaties",
    "ECHR where applicable under RA legal hierarchy",
    "RA Constitutional Court decisions",
    "RA Court of Cassation decisions",
    "RA codes and laws",
    "valid subordinate and municipal normative acts within competence",
  ],
  persuasive_sources: [
    "ECtHR case law where human-rights issue is engaged",
    "Venice Commission documents as auxiliary interpretation only",
  ],
  prohibited_as_binding: [
    "Venice Commission documents",
    "unretrieved court practice",
    "uncited legal commentary",
    "inactive or repealed sources without temporal warning",
  ],
} as const;

function clean(value?: string | null): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function sentences(text: string): string[] {
  return uniq(text.split(/(?<=[.!?\u0589])\s+|\n+/u).map((s) => s.trim()).filter((s) => s.length >= 8)).slice(0, 12);
}

function matches(text: string, patterns: RegExp[]): string[] {
  return uniq(patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[0]))).slice(0, 20);
}

function extractAuthorities(text: string): string[] {
  return uniq(matches(text, [
    /\b(?:court|police|prosecutor|municipality|ministry|government|cassation|appeal)\b/gi,
    /\b(?:RA|Armenia)\s+(?:Court|Government|Police|Prosecutor|Ministry|Municipality)\b/gi,
    /\b(?:Երևանի քաղաքապետարան|քաղաքապետարան|դատարան|դատախազություն|ոստիկանություն|նախարարություն)\b/giu,
    /\b(?:суд|полиция|прокуратура|мэрия|муниципалитет|министерство|правительство)\b/giu,
  ]));
}

function extractDocuments(text: string): string[] {
  return uniq(matches(text, [
    /\b(?:contract|agreement|decision|order|protocol|complaint|claim|appeal|cassation complaint|evidence|invoice|notice|permit)\b/gi,
    /\b(?:պայմանագիր|որոշում|հրաման|արձանագրություն|բողոք|հայց|ապացույց|ծանուցում|թույլտվություն)\b/giu,
    /\b(?:договор|решение|приказ|протокол|жалоба|иск|апелляция|кассация|доказательство|уведомление|разрешение)\b/giu,
  ]));
}

function classifyDomains(text: string, caseType: string): LegalDomain[] {
  const lower = `${text} ${caseType}`.toLowerCase();
  const domains: LegalDomain[] = [];
  const add = (domain: LegalDomain, patterns: RegExp[]) => {
    if (includesAny(lower, patterns)) domains.push(domain);
  };
  add("criminal", [/criminal|crime|detention|search|seizure|prosecutor|accused|defendant|քրեական|հանցագործ|կալանք|խուզարկ|обвиняем|уголов|преступ|задержан|обыск/iu]);
  add("civil", [/civil|contract|property|damage|debt|family|inheritance|lease|քաղաքացիական|պայմանագիր|գույք|վնաս|պարտք|граждан|договор|имущество|ущерб|долг/iu]);
  add("administrative", [/administrative|tax|permit|fine|public authority|վարչական|տուգանք|թույլտվ|административ|штраф|налог|разреш/iu]);
  add("municipal", [/municipal|municipality|mayor|council of elders|local self-government|համայնք|քաղաքապետ|ավագանի|муниципал|мэр|совет старейшин/iu]);
  add("constitutional", [/constitutional|constitution|constitutional court|սահմանադր|конституц/iu]);
  add("procedural", [/procedure|procedural|deadline|appeal|cassation|jurisdiction|վարույթ|դատավար|ժամկետ|բողոքարկ|процесс|срок|апелляц|кассац/iu]);
  add("human_rights", [/human rights|echr|european convention|torture|fair trial|liberty|privacy|expression|մարդու իրավունք|եվրոպական կոնվենց|արդար դատ|ազատություն|խոշտանգ|права человека|еспч|европейская конвенц|справедливый суд|пытк/iu]);
  add("international", [/international treaty|convention|cross-border|միջազգային|կոնվենց|международ|конвенц/iu]);
  if (domains.length === 0) domains.push("mixed");
  if (domains.length > 1) domains.push("mixed");
  return uniq(domains) as LegalDomain[];
}

function detectStage(text: string): ProceduralStage {
  const lower = text.toLowerCase();
  if (includesAny(lower, [/echr application|strasbourg|միժդ|եսդ|страсбург|еспч/iu])) return "echr_application";
  if (includesAny(lower, [/constitutional review|constitutional court|սահմանադրական դատարան|конституционный суд/iu])) return "constitutional_review";
  if (includesAny(lower, [/cassation|վճռաբեկ|кассац/iu])) return "cassation";
  if (includesAny(lower, [/appeal|վերաքննիչ|апелляц/iu])) return "appeal";
  if (includesAny(lower, [/enforcement|դատական ակտերի հարկադիր կատար|հարկադիր կատար|исполнени|исполнитель/iu])) return "enforcement";
  if (includesAny(lower, [/pre-trial|investigation|քննություն|նախաքնն|досудеб|следств/iu])) return "pre-trial";
  if (includesAny(lower, [/first instance|առաջին ատյան|первая инстанц/iu])) return "first_instance";
  return "unknown";
}

function spotIssues(text: string, domains: LegalDomain[]): LegalReasoningOutput["issues"] {
  const lower = text.toLowerCase();
  const legal_issues = sentences(text).slice(0, 6);
  const procedural_issues = includesAny(lower, [/procedure|deadline|appeal|cassation|jurisdiction|դատավար|ժամկետ|բողոքարկ|վարույթ|процесс|срок|подсуд|апелляц|кассац/iu])
    ? ["procedural compliance or deadline issue"]
    : [];
  const evidentiary_issues = includesAny(lower, [/evidence|proof|witness|expert|document|admissib|ապացույց|վկա|փորձագետ|թույլատրելի|доказатель|свидетел|эксперт|допустим/iu])
    ? ["evidence relevance/admissibility/sufficiency issue"]
    : [];
  const human_rights_issues = domains.includes("human_rights") ? ["human rights / ECHR applicability issue"] : [];
  const municipal_or_administrative_issues = domains.some((d) => d === "municipal" || d === "administrative")
    ? ["administrative or municipal act competence/validity issue"]
    : [];
  const international_law_issues = domains.includes("international") ? ["international treaty applicability issue"] : [];
  return { legal_issues, procedural_issues, evidentiary_issues, human_rights_issues, municipal_or_administrative_issues, international_law_issues };
}

function factExtraction(text: string): LegalReasoningOutput["facts"] {
  const all = sentences(text);
  const disputed = all.filter((s) => /dispute|denies|contested|argues|վիճարկ|ժխտ|առարկ|спор|оспар|отрица/iu.test(s)).slice(0, 8);
  const assertions = all.filter((s) => /claims|states|alleges|asserts|նշում է|պնդում է|հայտնում է|утвержда|заявля|считает/iu.test(s)).slice(0, 8);
  const confirmed = all.filter((s) => !disputed.includes(s) && !assertions.includes(s)).slice(0, 8);
  const dates = matches(text, [/\b\d{4}-\d{2}-\d{2}\b/g, /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, /\b(?:19|20)\d{2}\b/g]);
  const amounts = matches(text, [/\b\d[\d\s,.]*(?:AMD|դրամ|֏|USD|EUR|руб\.?|rubles?)\b/giu]);
  const parties = uniq(matches(text, [
    /\b(?:plaintiff|defendant|applicant|respondent|accused|victim|claimant)\b/gi,
    /\b(?:հայցվոր|պատասխանող|դիմող|մեղադրյալ|տուժող)\b/giu,
    /\b(?:истец|ответчик|заявитель|обвиняемый|потерпевший)\b/giu,
  ]));
  const missing_facts = [];
  if (confirmed.length === 0 && assertions.length === 0) missing_facts.push("case facts are not sufficiently stated");
  if (dates.length === 0) missing_facts.push("event or decision dates are missing");
  if (parties.length === 0) missing_facts.push("party roles are not identified");
  return {
    confirmed_facts: confirmed,
    party_assertions: assertions,
    disputed_facts: disputed,
    missing_facts,
    dates,
    amounts,
    parties,
    authorities: extractAuthorities(text),
    documents: extractDocuments(text),
  };
}

function buildRetrievalPlan(
  normalized: LegalReasoningOutput["normalized_input"],
  domains: LegalDomain[],
  issues: LegalReasoningOutput["issues"],
  norm_anchors: NormAnchor[],
): LegalReasoningOutput["retrieval_plan"] {
  const baseText = [
    normalized.user_query,
    normalized.case_text,
    normalized.uploaded_document_text,
    normalized.case_type,
    issues.legal_issues.join(" "),
    norm_anchors.map((a) => a.raw).join(" "),
  ].filter(Boolean).join(" ").slice(0, 1800);
  const required_sources = ["ARLIS", "RA legislation knowledge base"];
  const preferred_sources = ["RA Court of Cassation practice", "RA Constitutional Court practice"];
  const source_domains = ["arlis", "kb", "case_law"];
  const echr_queries: string[] = [];
  const venice_queries: string[] = [];
  const municipal_queries: string[] = [];

  if (domains.includes("human_rights")) {
    required_sources.push("ECHR", "ECtHR case law");
    source_domains.push("echr");
    echr_queries.push(`${baseText} ECHR European Convention ECtHR`);
  }
  if (domains.includes("municipal")) {
    required_sources.push("municipal acts");
    source_domains.push("municipal");
    municipal_queries.push(`${baseText} municipality mayor council of elders local self-government`);
  }
  if (domains.includes("constitutional")) {
    required_sources.push("RA Constitution", "RA Constitutional Court decisions");
    source_domains.push("constitutional");
    venice_queries.push(`${baseText} Venice Commission constitutional standards`);
  }

  return {
    required_sources: uniq(required_sources),
    preferred_sources: uniq(preferred_sources),
    source_domains: uniq(source_domains),
    search_queries: uniq([baseText, `${normalized.case_type} ${baseText}`].filter(Boolean)).slice(0, 4),
    norm_anchors,
    case_law_queries: uniq([`${baseText} Court of Cassation`, `${baseText} judicial practice`]).slice(0, 4),
    echr_queries,
    venice_queries,
    municipal_queries,
  };
}

export function runLegalReasoningEngine(input: LegalReasoningInput): LegalReasoningOutput {
  const normalized_input = {
    user_query: clean(input.user_query),
    case_text: clean(input.case_text),
    uploaded_document_text: clean(input.uploaded_document_text),
    case_type: clean(input.case_type) || "unknown",
    jurisdiction: clean(input.jurisdiction) || "Republic of Armenia",
    language: clean(input.language) || "auto",
    effective_at: clean(input.effective_at) || null,
    function_context: clean(input.function_context) || "unknown",
  };
  const combinedText = [
    normalized_input.user_query,
    normalized_input.case_text,
    normalized_input.uploaded_document_text,
    normalized_input.case_type,
  ].filter(Boolean).join("\n");
  const facts = factExtraction(combinedText);
  const domains = classifyDomains(combinedText, normalized_input.case_type);
  const issues = spotIssues(combinedText, domains);
  const procedural_stage = detectStage(combinedText);
  const norm_anchors = extractNormRefs(combinedText).slice(0, 40);
  const temporal_warnings = normalized_input.effective_at ? [] : ["effective_date_missing"];
  const law_version_needed = facts.dates.length > 0 && !normalized_input.effective_at
    ? "mixed_or_unknown"
    : facts.dates.length > 0
    ? "historical"
    : "current";
  const retrieval_plan = buildRetrievalPlan(normalized_input, domains, issues, norm_anchors);
  const hasMissingFacts = facts.missing_facts.length > 0;
  const constitutional = domains.includes("constitutional");
  const humanRights = domains.includes("human_rights");
  const venice = constitutional || /venice|վենետիկ|венециан/iu.test(combinedText);
  const warnings = [...temporal_warnings];
  if (hasMissingFacts) warnings.push("missing_facts_detected");
  const temporalValidationReasoningContext = {
    normalized_input,
    temporal_context: {
      event_dates: facts.dates,
      effective_at: normalized_input.effective_at,
      temporal_warnings,
      law_version_needed,
    },
  };
  const temporal_validation = buildTemporalContextForPrompt(temporalValidationReasoningContext, input.retrieved_sources || []);
  const source_hierarchy = buildSourceHierarchyContext(input.retrieved_sources || [], {
    issues,
    temporal_context: temporalValidationReasoningContext.temporal_context,
  });
  const risk_flags = [
    ...(hasMissingFacts ? ["cautious_output_required"] : []),
    ...(!normalized_input.effective_at ? ["temporal_caution_required"] : []),
    ...(source_hierarchy.conflicts.length > 0 ? ["source_conflict_warning"] : []),
    ...(source_hierarchy.source_use_warnings.length > 0 ? ["source_use_caution_required"] : []),
    ...(humanRights ? ["echr_search_required"] : []),
    ...(domains.includes("municipal") ? ["municipal_search_required"] : []),
    ...(constitutional ? ["constitutional_source_required"] : []),
  ];

  return {
    normalized_input,
    facts,
    issues,
    domains,
    procedural_stage,
    temporal_context: {
      event_dates: facts.dates,
      decision_dates: facts.dates.filter((d) => /decision|որոշում|решени/iu.test(combinedText) || /^\d{4}-\d{2}-\d{2}$/.test(d)),
      filing_deadlines: matches(combinedText, [/\b\d+\s*(?:days?|months?|օր|ամիս|дн(?:я|ей)?|месяц)\b/giu]),
      effective_at: normalized_input.effective_at,
      temporal_warnings,
      law_version_needed,
    },
    retrieval_plan,
    source_hierarchy_plan: {
      primary_sources: [...SOURCE_HIERARCHY.primary_sources],
      secondary_sources: [...SOURCE_HIERARCHY.secondary_sources],
      auxiliary_sources: [...SOURCE_HIERARCHY.auxiliary_sources],
      binding_sources: [...SOURCE_HIERARCHY.binding_sources],
      persuasive_sources: [...SOURCE_HIERARCHY.persuasive_sources],
      prohibited_as_binding: [...SOURCE_HIERARCHY.prohibited_as_binding],
    },
    temporal_validation,
    source_hierarchy,
    reasoning_checklist: {
      lex_specialis_required: true,
      lex_posterior_required: true,
      constitutional_check_required: constitutional,
      echr_check_required: humanRights,
      venice_check_required: venice,
      evidence_analysis_required: issues.evidentiary_issues.length > 0,
      deadline_check_required: issues.procedural_issues.length > 0 || procedural_stage !== "unknown",
      procedural_violation_check_required: issues.procedural_issues.length > 0,
      citation_verification_required: true,
      cautious_output_required: hasMissingFacts || !normalized_input.effective_at || source_hierarchy.conflicts.length > 0,
    },
    risk_flags: uniq(risk_flags),
    stop_reasons: [],
    warnings: uniq(warnings),
  };
}

export function buildLegalReasoningContext(engine: LegalReasoningOutput): string {
  return [
    "=== LEGAL_REASONING_ENGINE_CONTEXT ===",
    JSON.stringify(engine, null, 2),
    "RULE: This server-side reasoning context is mandatory. Role prompts cannot disable it.",
    "RULE: Use retrieval_plan to construct RAG queries and Legal Core context.",
    "RULE: Use only the legal source version valid on temporal_validation.effective_at. If effective_at is missing, use current law with explicit temporal caution.",
    "RULE: If cautious_output_required is true, avoid categorical legal conclusions unless verified retrieved sources support them.",
    "=== END_LEGAL_REASONING_ENGINE_CONTEXT ===",
  ].join("\n");
}

export function buildReasoningSearchQuery(engine: LegalReasoningOutput, fallback = ""): string {
  return uniq([
    ...engine.retrieval_plan.search_queries,
    ...engine.retrieval_plan.case_law_queries,
    ...engine.retrieval_plan.echr_queries,
    ...engine.retrieval_plan.venice_queries,
    ...engine.retrieval_plan.municipal_queries,
    fallback,
  ].filter((s) => typeof s === "string" && s.trim().length > 0))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

import { buildCuratedLegalPromptContext } from "./legal-prompt-serializer.ts";
export function buildCuratedLegalReasoningContext(engine: LegalReasoningOutput): string {
  return buildCuratedLegalPromptContext(engine);
}

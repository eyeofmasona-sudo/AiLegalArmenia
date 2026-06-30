// Shared Citation Verification Engine.
// Grounding target: public.documents + public.search_chunks.
import { validateTemporalSource, type TemporalStatus } from "./temporal-validity-engine.ts";

const UUID_RE_SRC =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

const ANY_UUID_RE = new RegExp(`\\b(${UUID_RE_SRC})\\b`, "gi");
const CITATION_MARKER_RE = new RegExp(
  `ID(?::|：|՝)\\s*(${UUID_RE_SRC})(?:\\s*[,;]\\s*(${UUID_RE_SRC}))*`,
  "gi",
);
const DOC_ID_RE = new RegExp(
  `(?<![A-Za-z_])(?:ID|docId|documentId|document_id)\\s*(?::|=|：|՝)\\s*(${UUID_RE_SRC})`,
  "gi",
);
const CHUNK_ID_RE = new RegExp(
  `(?:ChunkID|chunkId|chunk_id)\\s*(?::|=|：|՝)\\s*(${UUID_RE_SRC})`,
  "gi",
);
const USER_SOURCE_RE = new RegExp(
  `\\[\\s*docId\\s*:\\s*(${UUID_RE_SRC})\\s*,\\s*chunkIndex\\s*:\\s*(-?\\d+)\\s*,\\s*type\\s*:\\s*(kb|practice)`,
  "gi",
);

const ARTICLE_RE = new RegExp(
  `(?:article|art\\.?|ст(?:атья)?|հոդված)\\s*([0-9]+(?:\\.[0-9]+)?)`,
  "iu",
);
const PART_RE = new RegExp(
  `(?:part|част(?:ь|и)?|մաս)\\s*([0-9]+(?:\\.[0-9]+)?)`,
  "iu",
);
const POINT_RE = new RegExp(
  `(?:point|clause|пункт|կետ)\\s*([0-9]+(?:\\.[0-9]+)?)`,
  "iu",
);
const QUOTE_RE = /["“”«»]([^"“”«»]{12,700})["“”«»]/g;

export type EnforcementMode = "strict" | "annotate";

export type CitationReason =
  | "ok"
  | "no_citations"
  | "too_many_citations"
  | "unverified_ids"
  | "verification_query_failed";

export type CitationStatus = "verified" | "weak" | "missing" | "unverified";
export type CitationRiskLevel = "none" | "low" | "medium" | "high";

export interface CitationClaim {
  document_id?: string;
  chunk_id?: string;
  chunk_index?: number;
  quoted_text?: string;
  article_number?: string;
  part_number?: string;
  point_number?: string;
  expected_category?: string;
  raw: string;
}

export interface VerifiedCitation {
  status: CitationStatus;
  document_id?: string;
  chunk_id?: string;
  chunk_index?: number;
  title?: string;
  source_category?: string;
  normalized_status?: string;
  effective_from?: string | null;
  effective_to?: string | null;
  revision_date?: string | null;
  citation_anchor?: string | null;
  quoted_text?: string;
  article_number?: string;
  part_number?: string;
  point_number?: string;
  checks: {
    document_exists: boolean;
    chunk_exists: boolean;
    quote_in_chunk: boolean | "not_checked";
    article_matches: boolean | "not_checked";
    category_matches: boolean | "not_checked";
    active_or_current: boolean;
    has_revision_date: boolean;
    temporal_valid: boolean | "not_checked";
  };
  temporal_status?: TemporalStatus;
  temporal_warnings?: string[];
  reasons: string[];
}

export interface CitationValidation {
  citations_verified: boolean;
  missing_ids?: string[];
  cited_ids_count: number;
  reason: CitationReason;
  verified_citations: VerifiedCitation[];
  weak_citations: VerifiedCitation[];
  missing_citations: VerifiedCitation[];
  citation_risk_level: CitationRiskLevel;
  requires_cautious_language: boolean;
  forbidden_certainty_phrases: string[];
}

export interface VerifyOptions {
  maxCitedIds?: number;
  skipIds?: Array<string | null | undefined>;
  fn?: string;
  allowedCategories?: string[];
  referenceDate?: string | null;
}

type SupaResult<T> = { data: T | null; error: { message?: string } | null };
interface MinimalSupabase {
  from: (table: string) => unknown;
}
type Query = {
  select: (cols: string) => {
    in: (col: string, vals: string[]) => PromiseLike<SupaResult<Array<Record<string, unknown>>>>;
  };
};

const FORBIDDEN_CERTAINTY_PHRASES = [
  "точно установлено",
  "definitively established",
  "conclusively established",
  "հստակ հաստատված է",
];

const ACTIVE_STATUSES = new Set(["active", "partially_active"]);

function emptyValidation(reason: CitationReason, count = 0): CitationValidation {
  const risk: CitationRiskLevel = reason === "ok" || reason === "no_citations" ? "none" : "high";
  return {
    citations_verified: reason === "ok" || reason === "no_citations",
    cited_ids_count: count,
    reason,
    verified_citations: [],
    weak_citations: [],
    missing_citations: [],
    citation_risk_level: risk,
    requires_cautious_language: risk !== "none",
    forbidden_certainty_phrases: FORBIDDEN_CERTAINTY_PHRASES,
  };
}

function normalizeId(id: string | undefined): string | undefined {
  return id ? id.toLowerCase() : undefined;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesNormalized(haystack: string, needle: string | undefined): boolean | "not_checked" {
  if (!needle || normalizeText(needle).length < 8) return "not_checked";
  return normalizeText(haystack).includes(normalizeText(needle));
}

function windowAround(text: string, index: number, span = 700): string {
  return text.substring(Math.max(0, index - span), Math.min(text.length, index + span));
}

function extractNear(window: string, re: RegExp): string | undefined {
  const m = window.match(re);
  return m?.[1];
}

function extractQuote(window: string): string | undefined {
  let best = "";
  for (const m of window.matchAll(QUOTE_RE)) {
    const q = (m[1] || "").trim();
    if (q.length > best.length) best = q;
  }
  return best || undefined;
}

function claimKey(c: CitationClaim): string {
  return [
    c.document_id || "",
    c.chunk_id || "",
    c.chunk_index ?? "",
    c.quoted_text || "",
    c.article_number || "",
    c.expected_category || "",
  ].join("|");
}

export function extractCitedIds(text: string, mode: "markers" | "any" = "markers"): string[] {
  if (!text) return [];
  const ids: string[] = [];
  if (mode === "any") {
    for (const m of text.matchAll(ANY_UUID_RE)) ids.push(m[1].toLowerCase());
  } else {
    for (const match of text.matchAll(CITATION_MARKER_RE)) {
      for (const u of match[0].matchAll(ANY_UUID_RE)) ids.push(u[1].toLowerCase());
    }
  }
  return [...new Set(ids)];
}

export function extractCitationClaims(text: string, mode: "markers" | "any" = "markers"): CitationClaim[] {
  if (!text) return [];

  const claims: CitationClaim[] = [];

  for (const m of text.matchAll(USER_SOURCE_RE)) {
    const index = m.index ?? 0;
    const win = windowAround(text, index);
    claims.push({
      document_id: normalizeId(m[1]),
      chunk_index: Number(m[2]),
      expected_category: m[3] === "kb" ? "knowledge_base" : "practice",
      quoted_text: extractQuote(win),
      article_number: extractNear(win, ARTICLE_RE),
      part_number: extractNear(win, PART_RE),
      point_number: extractNear(win, POINT_RE),
      raw: m[0],
    });
  }

  for (const m of text.matchAll(DOC_ID_RE)) {
    const index = m.index ?? 0;
    const win = windowAround(text, index);
    const chunk = [...win.matchAll(CHUNK_ID_RE)].map((x) => normalizeId(x[1])).find(Boolean);
    claims.push({
      document_id: normalizeId(m[1]),
      chunk_id: chunk,
      quoted_text: extractQuote(win),
      article_number: extractNear(win, ARTICLE_RE),
      part_number: extractNear(win, PART_RE),
      point_number: extractNear(win, POINT_RE),
      raw: m[0],
    });
  }

  for (const m of text.matchAll(CHUNK_ID_RE)) {
    const index = m.index ?? 0;
    const win = windowAround(text, index);
    const doc = [...win.matchAll(DOC_ID_RE)].map((x) => normalizeId(x[1])).find(Boolean);
    claims.push({
      document_id: doc,
      chunk_id: normalizeId(m[1]),
      quoted_text: extractQuote(win),
      article_number: extractNear(win, ARTICLE_RE),
      part_number: extractNear(win, PART_RE),
      point_number: extractNear(win, POINT_RE),
      raw: m[0],
    });
  }

  if (mode === "any") {
    const known = new Set(claims.flatMap((c) => [c.document_id, c.chunk_id].filter(Boolean) as string[]));
    for (const m of text.matchAll(ANY_UUID_RE)) {
      const id = normalizeId(m[1])!;
      if (known.has(id)) continue;
      const win = windowAround(text, m.index ?? 0);
      claims.push({
        document_id: id,
        quoted_text: extractQuote(win),
        article_number: extractNear(win, ARTICLE_RE),
        part_number: extractNear(win, PART_RE),
        point_number: extractNear(win, POINT_RE),
        raw: m[0],
      });
    }
  }

  const seen = new Set<string>();
  const pairedChunks = new Set(
    claims
      .filter((c) => c.document_id && c.chunk_id)
      .map((c) => c.chunk_id),
  );
  return claims.filter((c) => {
    if (!c.document_id && c.chunk_id && pairedChunks.has(c.chunk_id)) return false;
    const key = claimKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function verifyAgainstAllowlist(
  citedIds: string[],
  allowedIds: Iterable<string>,
  opts: VerifyOptions = {},
): CitationValidation {
  const maxCitedIds = opts.maxCitedIds ?? 50;
  const skip = new Set((opts.skipIds ?? []).filter(Boolean).map((s) => String(s).toLowerCase()));
  const cited = citedIds.map((id) => id.toLowerCase()).filter((id) => !skip.has(id));

  if (cited.length === 0) return emptyValidation("no_citations", 0);
  if (cited.length > maxCitedIds) return emptyValidation("too_many_citations", cited.length);

  const allow = new Set([...allowedIds].map((s) => s.toLowerCase()));
  const missing = cited.filter((id) => !allow.has(id));
  const result = emptyValidation(missing.length === 0 ? "ok" : "unverified_ids", cited.length);
  result.missing_ids = missing.length ? missing : undefined;
  result.citations_verified = missing.length === 0;
  result.citation_risk_level = missing.length === 0 ? "none" : "high";
  result.requires_cautious_language = missing.length > 0;
  return result;
}

function titleOf(row: Record<string, unknown> | undefined): string | undefined {
  if (!row) return undefined;
  return String(row.title_hy || row.title_ru || row.title_en || row.canonical_key || row.document_id || "");
}

function sourceCategory(doc: Record<string, unknown> | undefined, chunk: Record<string, unknown> | undefined): string | undefined {
  const meta = doc?.source_metadata && typeof doc.source_metadata === "object" ? doc.source_metadata as Record<string, unknown> : {};
  return String(
    chunk?.content_domain ||
      doc?.content_domain ||
      meta.source ||
      meta.category ||
      "",
  ) || undefined;
}

function revisionDate(doc: Record<string, unknown> | undefined, chunk: Record<string, unknown> | undefined, version: Record<string, unknown> | undefined): string | null {
  return String(chunk?.effective_from || doc?.effective_from || version?.published_at || doc?.issued_date || "") || null;
}

function effectiveTo(doc: Record<string, unknown> | undefined, chunk: Record<string, unknown> | undefined): string | null {
  return String(chunk?.effective_to || doc?.effective_to || "") || null;
}

function activeCheck(doc: Record<string, unknown> | undefined, chunk: Record<string, unknown> | undefined): boolean {
  const status = String(chunk?.norm_status || doc?.normalized_status || "unknown").toLowerCase();
  return ACTIVE_STATUSES.has(status);
}

function categoryCheck(
  claim: CitationClaim,
  doc: Record<string, unknown> | undefined,
  chunk: Record<string, unknown> | undefined,
  allowedCategories: string[],
): boolean | "not_checked" {
  const expected = claim.expected_category ? [claim.expected_category] : allowedCategories;
  if (!expected.length) return "not_checked";
  const actual = sourceCategory(doc, chunk);
  if (!actual) return false;
  const actualNorm = actual.toLowerCase();
  return expected.map((c) => c.toLowerCase()).some((c) => actualNorm === c || actualNorm.includes(c));
}

function articleCheck(claim: CitationClaim, chunk: Record<string, unknown> | undefined): boolean | "not_checked" {
  const refs = [claim.article_number, claim.part_number, claim.point_number].filter(Boolean) as string[];
  if (!refs.length) return "not_checked";
  const text = `${chunk?.citation_anchor || ""}\n${chunk?.text || ""}`;
  return refs.every((ref) => normalizeText(text).includes(normalizeText(ref)));
}

async function queryRows(
  supabase: MinimalSupabase,
  table: string,
  columns: string,
  column: string,
  values: string[],
): Promise<SupaResult<Array<Record<string, unknown>>>> {
  if (values.length === 0) return { data: [], error: null };
  const query = supabase.from(table) as Query;
  return await query.select(columns).in(column, values);
}

export async function verifyCitationClaims(
  claims: CitationClaim[],
  supabase: MinimalSupabase,
  opts: VerifyOptions = {},
): Promise<CitationValidation> {
  const maxCitedIds = opts.maxCitedIds ?? 50;
  const skip = new Set((opts.skipIds ?? []).filter(Boolean).map((s) => String(s).toLowerCase()));
  const filtered = claims.filter((c) => {
    const doc = c.document_id?.toLowerCase();
    const chunk = c.chunk_id?.toLowerCase();
    return (!doc || !skip.has(doc)) && (!chunk || !skip.has(chunk));
  });

  if (filtered.length === 0) return emptyValidation("no_citations", 0);
  if (filtered.length > maxCitedIds) return emptyValidation("too_many_citations", filtered.length);

  const docIds = [...new Set(filtered.map((c) => c.document_id).filter(Boolean) as string[])];
  const chunkIds = [...new Set(filtered.map((c) => c.chunk_id).filter(Boolean) as string[])];

  const [docsResult, citedChunksResult, docChunksResult, versionsResult] = await Promise.all([
    queryRows(
      supabase,
      "documents",
      "document_id,canonical_key,title_hy,title_ru,title_en,content_domain,normalized_status,effective_from,effective_to,issued_date,source_metadata",
      "document_id",
      docIds,
    ),
    queryRows(
      supabase,
      "search_chunks",
      "chunk_id,document_id,text,citation_anchor,content_domain,norm_status,effective_from,effective_to",
      "chunk_id",
      chunkIds,
    ),
    queryRows(
      supabase,
      "search_chunks",
      "chunk_id,document_id,text,citation_anchor,content_domain,norm_status,effective_from,effective_to",
      "document_id",
      docIds,
    ),
    queryRows(
      supabase,
      "document_versions",
      "document_id,version_id,version_number,published_at,is_current",
      "document_id",
      docIds,
    ),
  ]);

  if (docsResult.error || citedChunksResult.error || docChunksResult.error || versionsResult.error) {
    return emptyValidation("verification_query_failed", filtered.length);
  }

  const docs = new Map((docsResult.data || []).map((r) => [String(r.document_id).toLowerCase(), r]));
  const chunksById = new Map<string, Record<string, unknown>>();
  const chunksByDoc = new Map<string, Record<string, unknown>[]>();
  for (const row of [...(citedChunksResult.data || []), ...(docChunksResult.data || [])]) {
    const chunkId = String(row.chunk_id).toLowerCase();
    chunksById.set(chunkId, row);
    const docId = String(row.document_id).toLowerCase();
    const list = chunksByDoc.get(docId) || [];
    if (!list.some((r) => String(r.chunk_id).toLowerCase() === chunkId)) list.push(row);
    chunksByDoc.set(docId, list);
  }
  const versions = new Map(
    (versionsResult.data || [])
      .filter((r) => r.is_current === true)
      .map((r) => [String(r.document_id).toLowerCase(), r]),
  );

  const verified: VerifiedCitation[] = [];
  const weak: VerifiedCitation[] = [];
  const missing: VerifiedCitation[] = [];
  const missingIds: string[] = [];

  for (const claim of filtered) {
    const docId = claim.document_id?.toLowerCase();
    const chunkId = claim.chunk_id?.toLowerCase();
    let chunk = chunkId ? chunksById.get(chunkId) : undefined;
    const inferredDocId = docId || (chunk ? String(chunk.document_id).toLowerCase() : undefined);
    const doc = inferredDocId ? docs.get(inferredDocId) : undefined;
    const docChunks = inferredDocId ? chunksByDoc.get(inferredDocId) || [] : [];

    if (!chunk && docChunks.length > 0 && (claim.quoted_text || claim.article_number)) {
      chunk = docChunks.find((row) => {
        const quoteOk = includesNormalized(String(row.text || ""), claim.quoted_text);
        const articleOk = articleCheck(claim, row);
        return quoteOk !== false && articleOk !== false;
      });
    }

    const documentExists = Boolean(doc || (chunk && chunk.document_id));
    const chunkExists = Boolean(chunkId ? chunk : false);
    const quoteInChunk = chunk ? includesNormalized(String(chunk.text || ""), claim.quoted_text) : (claim.quoted_text ? false : "not_checked");
    const artMatches = chunk ? articleCheck(claim, chunk) : (claim.article_number ? false : "not_checked");
    const catMatches = categoryCheck(claim, doc, chunk, opts.allowedCategories || []);
    const active = activeCheck(doc, chunk);
    const rev = revisionDate(doc, chunk, inferredDocId ? versions.get(inferredDocId) : undefined);
    const hasRevision = Boolean(rev);
    const temporal = validateTemporalSource({
      id: inferredDocId,
      document_id: inferredDocId,
      chunk_id: chunk ? String(chunk.chunk_id) : claim.chunk_id,
      title: titleOf(doc),
      norm_status: String(chunk?.norm_status || doc?.normalized_status || ""),
      effective_from: String(chunk?.effective_from || doc?.effective_from || "") || null,
      effective_to: effectiveTo(doc, chunk),
      is_current: inferredDocId ? Boolean(versions.get(inferredDocId)?.is_current) : undefined,
    }, opts.referenceDate || null);
    const temporalInvalid = ["not_yet_effective", "expired", "repealed", "conflicting_revision"].includes(temporal.temporal_status);

    const reasons: string[] = [];
    if (!documentExists) reasons.push("document_id_not_found");
    if (claim.chunk_id && !chunk) reasons.push("chunk_id_not_found");
    if (!claim.chunk_id) reasons.push("chunk_id_not_cited");
    if (quoteInChunk === false) reasons.push("quoted_text_not_found_in_chunk");
    if (artMatches === false) reasons.push("article_part_point_mismatch");
    if (catMatches === false) reasons.push("source_category_mismatch");
    if (!active) reasons.push("source_not_active");
    if (temporalInvalid) reasons.push(`source_temporal_invalid:${temporal.temporal_status}`);
    if (temporal.temporal_status === "missing_reference_date") reasons.push("effective_date_missing");
    if (temporal.temporal_status === "unknown_effective_date") reasons.push("source_effective_date_unknown");
    if (!hasRevision) reasons.push("revision_date_missing");

    let status: CitationStatus = "verified";
    if (!documentExists || (claim.chunk_id && !chunk)) {
      status = "missing";
      if (claim.document_id) missingIds.push(claim.document_id);
      if (claim.chunk_id) missingIds.push(claim.chunk_id);
    } else if (quoteInChunk === false || artMatches === false || catMatches === false || !active || temporalInvalid) {
      status = "unverified";
    } else if (!claim.chunk_id || !hasRevision || quoteInChunk === "not_checked" || artMatches === "not_checked" || temporal.temporal_status === "missing_reference_date" || temporal.temporal_status === "unknown_effective_date") {
      status = "weak";
    }

    const item: VerifiedCitation = {
      status,
      document_id: inferredDocId,
      chunk_id: chunk ? String(chunk.chunk_id).toLowerCase() : claim.chunk_id,
      chunk_index: claim.chunk_index,
      title: titleOf(doc),
      source_category: sourceCategory(doc, chunk),
      normalized_status: String(chunk?.norm_status || doc?.normalized_status || "unknown"),
      effective_from: String(chunk?.effective_from || doc?.effective_from || "") || null,
      effective_to: effectiveTo(doc, chunk),
      revision_date: rev,
      citation_anchor: chunk ? String(chunk.citation_anchor || "") || null : null,
      quoted_text: claim.quoted_text,
      article_number: claim.article_number,
      part_number: claim.part_number,
      point_number: claim.point_number,
      checks: {
        document_exists: documentExists,
        chunk_exists: chunkExists,
        quote_in_chunk: quoteInChunk,
        article_matches: artMatches,
        category_matches: catMatches,
        active_or_current: active,
        has_revision_date: hasRevision,
        temporal_valid: temporal.temporal_valid,
      },
      temporal_status: temporal.temporal_status,
      temporal_warnings: temporal.temporal_warnings,
      reasons,
    };

    if (status === "verified") verified.push(item);
    else if (status === "missing") missing.push(item);
    else weak.push(item);
  }

  const risk: CitationRiskLevel = missing.length > 0 || weak.some((c) => c.status === "unverified")
    ? "high"
    : weak.length > 0
      ? "medium"
      : verified.length > 0
        ? "low"
        : "none";

  return {
    citations_verified: missing.length === 0 && weak.length === 0,
    missing_ids: [...new Set(missingIds)].length ? [...new Set(missingIds)] : undefined,
    cited_ids_count: filtered.length,
    reason: missing.length > 0 || weak.length > 0 ? "unverified_ids" : "ok",
    verified_citations: verified,
    weak_citations: weak,
    missing_citations: missing,
    citation_risk_level: risk,
    requires_cautious_language: risk !== "none" && risk !== "low",
    forbidden_certainty_phrases: FORBIDDEN_CERTAINTY_PHRASES,
  };
}

export async function verifyAgainstDb(
  citedIds: string[],
  supabase: MinimalSupabase,
  opts: VerifyOptions = {},
): Promise<CitationValidation> {
  const claims = citedIds.map((id) => ({ document_id: id.toLowerCase(), raw: `ID:${id}` }));
  return await verifyCitationClaims(claims, supabase, opts);
}

export async function verifyCitationsInText(
  text: string,
  supabase: MinimalSupabase,
  opts: VerifyOptions & { mode?: "markers" | "any" } = {},
): Promise<CitationValidation> {
  return await verifyCitationClaims(extractCitationClaims(text, opts.mode || "markers"), supabase, opts);
}

export function shouldReject(result: CitationValidation, mode: EnforcementMode): boolean {
  return mode === "strict" && !result.citations_verified;
}

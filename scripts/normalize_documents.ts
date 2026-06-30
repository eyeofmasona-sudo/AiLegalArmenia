/**
 * S3 normalization: internal.source_files -> public.documents / versions / pages.
 *
 * Default is --dry-run. Use --commit to write.
 * Audit rules:
 * - Skip source_files.quarantined=true.
 * - Do not normalize hard blockers/review records (empty text, missing doc id,
 *   missing title, severe OCR/review flags).
 * - Derive ARLIS source_url from metadata.arlis_doc_id, fallback regex from full_text.
 * - Map raw status into normalized_status, retaining dirty_status as quality flag.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";
import {
  detectTextQualityFlags,
  deriveArlisSourceUrl,
  getArlisDocId,
  getMeta,
  hasHardBlockerOrReview,
  loadDuplicateAudit,
  mergeReasons,
  normalizeStatus,
  parseCommonArgs,
  parseDate,
  requireEnv,
  sha256Hex,
} from "./pipeline_common.ts";
import { connectPipelineDatabase, fetchInternalSourceFiles, updateInternalSourceUrl } from "./pipeline_db.ts";

interface CliOptions {
  dryRun: boolean;
  batchSize: number;
  limit?: number;
  jobId?: string;
}

interface Counters {
  source_files_read: number;
  skipped_quarantined_or_review: number;
  duplicate_candidates_marked: number;
  documents_upserted: number;
  versions_upserted: number;
  pages_upserted: number;
  authorities_seeded: number;
  failed: number;
}

function parseArgs(args: string[]): CliOptions {
  let jobId: string | undefined;
  const base = parseCommonArgs(args, { batchSize: 500 }, (arg, index, all) => {
    if (arg === "--job-id") {
      jobId = all[index + 1];
      return index + 1;
    }
    return undefined;
  });
  return { dryRun: base.dryRun, batchSize: base.batchSize, limit: base.limit, jobId };
}

function printHelp() {
  console.log(`Usage:
  deno run --allow-env --allow-net scripts/normalize_documents.ts \\
    [--dry-run|--commit] [--limit N] [--batch N] [--job-id uuid]

Aliases: --write == --commit.
`);
}

function cleanDocNumber(raw: string): string | null {
  const cleaned = raw.replace(/^[\w.-]{1,12}\s*/i, "").trim();
  return cleaned || raw.trim() || null;
}

function deriveQualityFlags(
  record: Record<string, unknown>,
  sourceFile: { quarantined?: boolean | null; quarantine_reason?: string | null; text_sha256?: string | null },
  duplicate: boolean,
): string[] {
  const meta = getMeta(record);
  const fullText = typeof record.full_text === "string" ? record.full_text : "";
  const title = String(record.title ?? meta.title ?? "").trim();
  const arlisId = getArlisDocId(record);
  const rawStatus = meta.status ?? record.status;
  const { dirty } = normalizeStatus(rawStatus);

  const flags: string[] = [];
  if (sourceFile.quarantined && sourceFile.quarantine_reason) flags.push(...sourceFile.quarantine_reason.split(","));
  flags.push(...detectTextQualityFlags(fullText));
  if (!arlisId) flags.push("missing_doc_id");
  if (!title) flags.push("missing_title");
  if (!deriveArlisSourceUrl(record)) flags.push("missing_source_url");
  if (dirty) flags.push("dirty_status");
  if (duplicate) flags.push("duplicate_candidate");
  const pages = Array.isArray(record.pages) ? record.pages : [];
  if (pages.length > 0) {
    const hasAnchorGap = pages.some((page, index) => {
      if (!page || typeof page !== "object") return true;
      const row = page as Record<string, unknown>;
      const pageNumber = typeof row.page === "number" ? row.page : typeof row.page_number === "number" ? row.page_number : index + 1;
      return pageNumber <= 0 || typeof row.text !== "string" || !row.text.trim();
    });
    if (hasAnchorGap) flags.push("needs_human_review");
  } else {
    flags.push("needs_human_review");
  }
  return mergeReasons(flags);
}

async function seedLookups(
  supabase: SupabaseClient,
  records: Record<string, unknown>[],
): Promise<{ docTypes: Map<string, string>; authorities: Map<string, string> }> {
  const docTypes = new Map<string, string>();
  const authorities = new Map<string, string>();
  const docTypeCodes = new Set<string>();
  const authorityNames = new Set<string>();

  for (const record of records) {
    const meta = getMeta(record);
    const docType = String(meta.doc_type ?? meta.document_type ?? "").trim();
    const authority = String(meta.issuing_body ?? meta.authority ?? "").trim();
    if (docType) docTypeCodes.add(docType);
    if (authority) authorityNames.add(authority);
  }

  for (const code of docTypeCodes) {
    const { data, error } = await supabase.from("document_types")
      .upsert({ code }, { onConflict: "code" })
      .select("document_type_id, code")
      .single();
    if (error) throw new Error(`document_types ${code}: ${error.message}`);
    docTypes.set(code, data.document_type_id);
  }

  for (const name of authorityNames) {
    const { data: existing, error: selectError } = await supabase.from("authorities")
      .select("authority_id, name_raw")
      .eq("name_raw", name)
      .limit(1)
      .maybeSingle();
    if (selectError) throw new Error(`authorities ${name}: ${selectError.message}`);
    if (existing) {
      authorities.set(name, existing.authority_id);
      continue;
    }

    const { data, error } = await supabase.from("authorities")
      .insert({ name_raw: name })
      .select("authority_id, name_raw")
      .maybeSingle();
    if (error) throw new Error(`authorities ${name}: ${error.message}`);
    if (data) authorities.set(name, data.authority_id);
  }

  return { docTypes, authorities };
}

async function run() {
  if (Deno.args.includes("--help")) {
    printHelp();
    return;
  }

  const opts = parseArgs(Deno.args);
  const duplicateAudit = await loadDuplicateAudit();
  const db = await connectPipelineDatabase();
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  const counters: Counters = {
    source_files_read: 0,
    skipped_quarantined_or_review: 0,
    duplicate_candidates_marked: 0,
    documents_upserted: 0,
    versions_upserted: 0,
    pages_upserted: 0,
    authorities_seeded: 0,
    failed: 0,
  };

  try {
    let processed = 0;
    let offset = 0;
    while (true) {
      if (opts.limit && processed >= opts.limit) break;
      const remaining = opts.limit ? Math.min(opts.batchSize, opts.limit - processed) : opts.batchSize;

      const sourceFiles = await fetchInternalSourceFiles(db, {
        limit: remaining,
        offset,
        jobId: opts.jobId,
      });
      if (sourceFiles.length === 0) break;
      counters.source_files_read += sourceFiles.length;

    const records = sourceFiles
      .map((sf) => sf.raw_record as Record<string, unknown> | null)
      .filter((r): r is Record<string, unknown> => Boolean(r));

    const lookups = opts.dryRun
      ? { docTypes: new Map<string, string>(), authorities: new Map<string, string>() }
      : await seedLookups(supabase, records);
    counters.authorities_seeded += lookups.authorities.size;

    for (const sf of sourceFiles) {
      processed++;
      const record = sf.raw_record as Record<string, unknown> | null;
      if (!record) {
        counters.skipped_quarantined_or_review++;
        continue;
      }

      const meta = getMeta(record);
      const arlisId = getArlisDocId(record);
      const duplicate = duplicateAudit.has(`doc_id:${arlisId}`) || duplicateAudit.has(`line:${processed}`);
      const qualityFlags = deriveQualityFlags(record, sf, duplicate);
      if (duplicate) counters.duplicate_candidates_marked++;

      if (hasHardBlockerOrReview(qualityFlags)) {
        counters.skipped_quarantined_or_review++;
        continue;
      }

      const fullText = typeof record.full_text === "string" ? record.full_text : "";
      const sourceUrl = deriveArlisSourceUrl(record);
      const rawStatus = String(meta.status ?? record.status ?? "").trim() || null;
      const { normalized: normalizedStatus } = normalizeStatus(rawStatus);
      const docTypeCode = String(meta.doc_type ?? meta.document_type ?? "").trim();
      const authorityName = String(meta.issuing_body ?? meta.authority ?? "").trim();
      const canonicalKey = `arlis:${arlisId}`;
      const textSha256 = sf.text_sha256 ?? await sha256Hex(fullText);

      if (opts.dryRun) {
        counters.documents_upserted++;
        counters.versions_upserted++;
        const pages = Array.isArray(record.pages) ? record.pages.length : 0;
        counters.pages_upserted += pages;
        continue;
      }

      const { data: doc, error: docError } = await supabase.from("documents")
        .upsert({
          canonical_key: canonicalKey,
          arlis_doc_id: arlisId,
          document_type_id: lookups.docTypes.get(docTypeCode) ?? null,
          content_domain: "unknown",
          title_hy: String(record.title ?? meta.title ?? "").trim() || null,
          doc_number_raw: String(meta.doc_number ?? meta.number ?? "").trim() || null,
          doc_number_clean: cleanDocNumber(String(meta.doc_number ?? meta.number ?? "")),
          issued_date: parseDate(meta.adoption_date ?? meta.date ?? record.issued_date),
          effective_from: parseDate(meta.in_force_date ?? meta.effective_from),
          effective_to: parseDate(meta.expires_date ?? meta.effective_to),
          raw_status: rawStatus,
          normalized_status: normalizedStatus,
          quality_flags: qualityFlags,
          needs_human_review: hasHardBlockerOrReview(qualityFlags),
        }, { onConflict: "canonical_key" })
        .select("document_id")
        .single();

      if (docError) {
        counters.failed++;
        console.error(`[S3] document ${canonicalKey}: ${docError.message}`);
        continue;
      }
      counters.documents_upserted++;

      const { data: version, error: versionError } = await supabase.from("document_versions")
        .upsert({
          document_id: doc.document_id,
          version_number: 1,
          source_file_id: sf.source_file_id,
          full_text: fullText,
          text_sha256: textSha256,
          page_count: typeof record.page_count === "number" ? record.page_count : null,
          language_code: String(meta.language_code ?? "hy"),
          is_current: true,
          published_at: parseDate(meta.publication_date ?? meta.adoption_date),
        }, { onConflict: "document_id, version_number" })
        .select("version_id")
        .single();

      if (versionError) {
        counters.failed++;
        console.error(`[S3] version ${canonicalKey}: ${versionError.message}`);
        continue;
      }
      counters.versions_upserted++;

      const pages = Array.isArray(record.pages) ? record.pages : [];
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i] as Record<string, unknown> | null;
        if (!page || typeof page !== "object") continue;
        const pageNumber = typeof page.page === "number"
          ? page.page
          : typeof page.page_number === "number"
            ? page.page_number
            : i + 1;
        const { error: pageError } = await supabase.from("document_pages")
          .upsert({
            version_id: version.version_id,
            page_number: pageNumber,
            page_text: typeof page.text === "string" ? page.text : null,
          }, { onConflict: "version_id, page_number" });
        if (pageError) counters.failed++;
        else counters.pages_upserted++;
      }

      const authorityId = authorityName ? lookups.authorities.get(authorityName) : null;
      if (authorityId) {
        await supabase.from("version_authorities").upsert({
          version_id: version.version_id,
          authority_id: authorityId,
          authority_role: "issuer",
        }, { onConflict: "version_id, authority_id, authority_role" });
      }

      if (sourceUrl && sf.source_url !== sourceUrl) {
        await updateInternalSourceUrl(db, sf.source_file_id, sourceUrl);
      }
    }

      console.log(`[S3] offset=${offset} ${JSON.stringify(counters)}`);
      offset += sourceFiles.length;
      if (sourceFiles.length < remaining) break;
    }
  } finally {
    await db.end();
  }

  console.log(JSON.stringify({ stage: "S3", dry_run: opts.dryRun, limit: opts.limit ?? null, counters }, null, 2));
}

if (import.meta.main) await run();

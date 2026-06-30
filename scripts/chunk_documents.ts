/**
 * S5 frozen chunking: public.document_versions -> public.search_chunks.
 *
 * Default is --dry-run. Use --commit to write.
 * - Skips review/blocker documents.
 * - Emits normal text chunks and table chunks separately.
 * - Stable chunk_key values are deterministic and should be treated as frozen
 *   once embeddings are generated.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";
import {
  hasHardBlockerOrReview,
  mergeReasons,
  parseCommonArgs,
  requireEnv,
  sha256Hex,
} from "./pipeline_common.ts";
import { connectPipelineDatabase, fetchInternalSourceFileMap } from "./pipeline_db.ts";

interface CliOptions {
  dryRun: boolean;
  batchSize: number;
  limit?: number;
  domain?: string;
}

interface ChunkRow {
  chunk_key: string;
  document_id: string;
  version_id: string;
  legal_unit_id: string | null;
  text: string;
  token_count: number;
  page_from: number | null;
  page_to: number | null;
  char_start: number;
  char_end: number;
  language_code: string;
  content_domain: string;
  norm_status: string;
  effective_from: string | null;
  effective_to: string | null;
  source_url: string | null;
  citation_anchor: string | null;
  chunk_text_sha256: string;
}

interface Counters {
  versions_read: number;
  versions_skipped_review: number;
  text_chunks: number;
  table_chunks: number;
  chunks_upserted: number;
  embeddings_reset: number;
  failed: number;
}

const TARGET_TOKENS = 1000;
const OVERLAP_TOKENS = 120;
const CHARS_PER_TOKEN = 4;

function parseArgs(args: string[]): CliOptions {
  let domain: string | undefined;
  const base = parseCommonArgs(args, { batchSize: 100 }, (arg, index, all) => {
    if (arg === "--domain") {
      domain = all[index + 1];
      return index + 1;
    }
    return undefined;
  });
  return { dryRun: base.dryRun, batchSize: base.batchSize, limit: base.limit, domain };
}

function printHelp() {
  console.log(`Usage:
  deno run --allow-env --allow-net scripts/chunk_documents.ts \\
    [--dry-run|--commit] [--limit N] [--batch N] [--domain knowledge_base|practice|unknown]

Aliases: --write == --commit.
`);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[։.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function slidingChunks(fullText: string): Array<{ text: string; charStart: number; charEnd: number }> {
  const sentences = splitSentences(fullText);
  const chunks: Array<{ text: string; charStart: number; charEnd: number }> = [];
  let i = 0;
  let searchFrom = 0;

  while (i < sentences.length) {
    const selected: string[] = [];
    let tokens = 0;
    let j = i;
    while (j < sentences.length) {
      const nextTokens = estimateTokens(sentences[j]);
      if (selected.length > 0 && tokens + nextTokens > TARGET_TOKENS) break;
      selected.push(sentences[j]);
      tokens += nextTokens;
      j++;
    }
    if (selected.length === 0) break;

    const text = selected.join(" ");
    const charStart = Math.max(0, fullText.indexOf(selected[0], searchFrom));
    const charEnd = charStart + text.length;
    chunks.push({ text, charStart, charEnd });

    searchFrom = Math.max(0, charEnd - OVERLAP_TOKENS * CHARS_PER_TOKEN);
    i = Math.max(j - 1, i + 1);
  }

  return chunks;
}

function tableToText(table: Record<string, unknown>): string {
  const columns = Array.isArray(table.columns) ? table.columns.map(String) : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const lines = [];
  if (columns.length) lines.push(columns.join(" | "));
  for (const row of rows) {
    if (Array.isArray(row)) lines.push(row.map(String).join(" | "));
    else if (row && typeof row === "object") lines.push(Object.values(row).map(String).join(" | "));
  }
  return lines.join("\n").trim();
}

async function buildChunks(
  version: Record<string, unknown>,
  doc: Record<string, unknown>,
  sourceUrl: string | null,
): Promise<{ rows: ChunkRow[]; tableCount: number; textCount: number }> {
  const versionId = String(version.version_id);
  const documentId = String(doc.document_id);
  const fullText = String(version.full_text ?? "");
  const languageCode = String(version.language_code ?? "hy");
  const contentDomain = String(doc.content_domain ?? "unknown");
  const normStatus = String(doc.normalized_status ?? "unknown");
  const effectiveFrom = typeof doc.effective_from === "string" ? doc.effective_from : null;
  const effectiveTo = typeof doc.effective_to === "string" ? doc.effective_to : null;
  const arlisId = String(doc.arlis_doc_id ?? doc.canonical_key ?? "").replace(/^arlis:/, "");
  const rows: ChunkRow[] = [];
  let textCount = 0;
  let tableCount = 0;

  for (const chunk of slidingChunks(fullText)) {
    const textHash = await sha256Hex(chunk.text);
    rows.push({
      chunk_key: await sha256Hex(`${versionId}|text|${chunk.charStart}|${chunk.charEnd}|${textHash}`),
      document_id: documentId,
      version_id: versionId,
      legal_unit_id: null,
      text: chunk.text,
      token_count: estimateTokens(chunk.text),
      page_from: null,
      page_to: null,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      language_code: languageCode,
      content_domain: contentDomain,
      norm_status: normStatus,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      source_url: sourceUrl,
      citation_anchor: arlisId ? `ARLIS ${arlisId}` : null,
      chunk_text_sha256: textHash,
    });
    textCount++;
  }

  const raw = version.raw_record as Record<string, unknown> | null;
  const tables = Array.isArray(raw?.tables) ? raw.tables : [];
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i] as Record<string, unknown> | null;
    if (!table || typeof table !== "object") continue;
    const text = tableToText(table);
    if (!text) continue;
    const textHash = await sha256Hex(text);
    const page = typeof table.page === "number" ? table.page : null;
    rows.push({
      chunk_key: await sha256Hex(`${versionId}|table|${page ?? "na"}|${i}|${textHash}`),
      document_id: documentId,
      version_id: versionId,
      legal_unit_id: null,
      text,
      token_count: estimateTokens(text),
      page_from: page,
      page_to: page,
      char_start: 0,
      char_end: text.length,
      language_code: languageCode,
      content_domain: contentDomain,
      norm_status: normStatus,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      source_url: sourceUrl,
      citation_anchor: arlisId ? `ARLIS ${arlisId}, table ${i + 1}${page ? `, p.${page}` : ""}` : `table ${i + 1}`,
      chunk_text_sha256: textHash,
    });
    tableCount++;
  }

  return { rows, textCount, tableCount };
}

async function run() {
  if (Deno.args.includes("--help")) {
    printHelp();
    return;
  }

  const opts = parseArgs(Deno.args);
  const db = await connectPipelineDatabase();
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  const counters: Counters = {
    versions_read: 0,
    versions_skipped_review: 0,
    text_chunks: 0,
    table_chunks: 0,
    chunks_upserted: 0,
    embeddings_reset: 0,
    failed: 0,
  };

  try {
    let offset = 0;
    while (true) {
    if (opts.limit && counters.versions_read >= opts.limit) break;
    const remaining = opts.limit ? Math.min(opts.batchSize, opts.limit - counters.versions_read) : opts.batchSize;

    let query = supabase.from("document_versions")
      .select(`
        version_id, document_id, full_text, language_code, source_file_id,
        documents!inner(
          document_id, arlis_doc_id, canonical_key, content_domain, normalized_status,
          effective_from, effective_to, quality_flags, needs_human_review
        )
      `)
      .eq("is_current", true)
      .not("full_text", "is", null)
      .range(offset, offset + remaining - 1);
    if (opts.domain) query = query.eq("documents.content_domain", opts.domain);

    const { data: versions, error } = await query;
    if (error) throw new Error(`document_versions fetch: ${error.message}`);
    if (!versions || versions.length === 0) break;

      const sourceIds = versions.map((v) => v.source_file_id).filter((id): id is string => typeof id === "string");
      const sourceMap = await fetchInternalSourceFileMap(db, sourceIds);

    for (const version of versions) {
      counters.versions_read++;
      const doc = Array.isArray(version.documents) ? version.documents[0] : version.documents;
      if (!doc) continue;
      const flags = Array.isArray(doc.quality_flags) ? doc.quality_flags.map(String) : [];
      if (doc.needs_human_review === true || hasHardBlockerOrReview(mergeReasons(flags))) {
        counters.versions_skipped_review++;
        continue;
      }

      const source = typeof version.source_file_id === "string" ? sourceMap.get(version.source_file_id) : undefined;
      const enrichedVersion = { ...version, raw_record: source?.raw_record ?? null };
      const built = await buildChunks(
        enrichedVersion as Record<string, unknown>,
        doc as Record<string, unknown>,
        source?.source_url ?? null,
      );
      counters.text_chunks += built.textCount;
      counters.table_chunks += built.tableCount;

      if (opts.dryRun) continue;

      for (let i = 0; i < built.rows.length; i += 50) {
        const batch = built.rows.slice(i, i + 50);
        const { data: upserted, error: upsertError } = await supabase.from("search_chunks")
          .upsert(batch, { onConflict: "chunk_key" })
          .select("chunk_id, chunk_text_sha256");
        if (upsertError) {
          counters.failed++;
          console.error(`[S5] upsert version=${version.version_id}: ${upsertError.message}`);
          continue;
        }
        counters.chunks_upserted += batch.length;
        const changedIds = (upserted ?? [])
          .filter((row, idx) => row.chunk_text_sha256 !== batch[idx]?.chunk_text_sha256)
          .map((row) => row.chunk_id);
        if (changedIds.length) {
          const { error: resetError } = await supabase.from("embeddings")
            .update({ status: "pending", error_message: null })
            .in("chunk_id", changedIds);
          if (!resetError) counters.embeddings_reset += changedIds.length;
        }
      }
    }

      console.log(`[S5] offset=${offset} ${JSON.stringify(counters)}`);
      offset += versions.length;
      if (versions.length < remaining) break;
    }
  } finally {
    await db.end();
  }

  console.log(JSON.stringify({ stage: "S5", dry_run: opts.dryRun, frozen_chunk_keys: true, limit: opts.limit ?? null, counters }, null, 2));
}

if (import.meta.main) await run();

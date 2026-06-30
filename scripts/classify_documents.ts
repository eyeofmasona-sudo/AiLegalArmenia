/**
 * S4 classification and dedup marking.
 *
 * Default is --dry-run. Use --commit to call Gemini 2.5 Flash and update
 * public.documents. Duplicate candidates are marked in quality_flags; rows are
 * never deleted.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";
import {
  loadDuplicateAudit,
  mergeReasons,
  normalizeStatus,
  parseCommonArgs,
  requireEnv,
} from "./pipeline_common.ts";

type ContentDomain = "knowledge_base" | "practice" | "unknown";
type NormalizedStatus = "active" | "repealed" | "partially_active" | "draft" | "unknown";

interface CliOptions {
  dryRun: boolean;
  batchSize: number;
  limit?: number;
  model: string;
}

interface Classification {
  content_domain: ContentDomain;
  normalized_status: NormalizedStatus;
  confidence: number;
  reason: string;
}

interface Counters {
  documents_read: number;
  duplicate_candidates_marked: number;
  classified: number;
  skipped_review: number;
  failed: number;
  gemini_calls: number;
}

function parseArgs(args: string[]): CliOptions {
  let model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
  const base = parseCommonArgs(args, { batchSize: 50 }, (arg, index, all) => {
    if (arg === "--model") {
      model = all[index + 1];
      return index + 1;
    }
    return undefined;
  });
  return { dryRun: base.dryRun, batchSize: base.batchSize, limit: base.limit, model };
}

function printHelp() {
  console.log(`Usage:
  deno run --allow-env --allow-net scripts/classify_documents.ts \\
    [--dry-run|--commit] [--limit N] [--batch N] [--model gemini-2.5-flash]

Env with --commit: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY.
`);
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function heuristicClassify(row: Record<string, unknown>, text: string): Classification {
  const haystack = `${row.title_hy ?? ""}\n${text.slice(0, 4000)}`.toLowerCase();
  const rawStatus = row.raw_status ?? "";
  const normalized = normalizeStatus(rawStatus).normalized;

  const practiceHints = [
    "դատարան",
    "վճիռ",
    "որոշեց",
    "դատական",
    "court",
    "judgment",
    "case no",
  ];

  const content_domain: ContentDomain = practiceHints.some((hint) => haystack.includes(hint))
    ? "practice"
    : "knowledge_base";

  return {
    content_domain,
    normalized_status: normalized,
    confidence: 0.45,
    reason: "dry-run heuristic",
  };
}

async function classifyWithGemini(
  apiKey: string,
  model: string,
  row: Record<string, unknown>,
  text: string,
): Promise<Classification> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    "Classify this Armenian legal corpus document. Return ONLY JSON.",
    'Schema: {"content_domain":"knowledge_base|practice|unknown","normalized_status":"active|repealed|partially_active|draft|unknown","confidence":0..1,"reason":"short"}',
    `Title: ${row.title_hy ?? ""}`,
    `Raw status: ${row.raw_status ?? ""}`,
    `Text excerpt:\n${text.slice(0, 12000)}`,
  ].join("\n\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const json = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const textResponse = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const parsed = JSON.parse(textResponse) as Record<string, unknown>;
  const contentDomain = parsed.content_domain;
  const normalizedStatus = parsed.normalized_status;

  return {
    content_domain: contentDomain === "knowledge_base" || contentDomain === "practice" || contentDomain === "unknown"
      ? contentDomain
      : "unknown",
    normalized_status: normalizedStatus === "active" ||
      normalizedStatus === "repealed" ||
      normalizedStatus === "partially_active" ||
      normalizedStatus === "draft" ||
      normalizedStatus === "unknown"
      ? normalizedStatus
      : "unknown",
    confidence: clampConfidence(parsed.confidence),
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "gemini",
  };
}

async function run() {
  if (Deno.args.includes("--help")) {
    printHelp();
    return;
  }

  const opts = parseArgs(Deno.args);
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  const geminiKey = opts.dryRun ? null : requireEnv("GEMINI_API_KEY");
  const duplicates = await loadDuplicateAudit();
  const counters: Counters = {
    documents_read: 0,
    duplicate_candidates_marked: 0,
    classified: 0,
    skipped_review: 0,
    failed: 0,
    gemini_calls: 0,
  };

  let offset = 0;
  while (true) {
    if (opts.limit && counters.documents_read >= opts.limit) break;
    const remaining = opts.limit ? Math.min(opts.batchSize, opts.limit - counters.documents_read) : opts.batchSize;

    const { data: versions, error } = await supabase.from("document_versions")
      .select(`
        version_id, full_text,
        documents!inner(document_id, arlis_doc_id, title_hy, raw_status, content_domain, normalized_status, quality_flags, needs_human_review)
      `)
      .eq("is_current", true)
      .not("full_text", "is", null)
      .range(offset, offset + remaining - 1);
    if (error) throw new Error(`document_versions fetch: ${error.message}`);
    if (!versions || versions.length === 0) break;

    for (const version of versions) {
      counters.documents_read++;
      const document = Array.isArray(version.documents) ? version.documents[0] : version.documents;
      if (!document) continue;

      const doc = document as Record<string, unknown>;
      const flags = Array.isArray(doc.quality_flags) ? doc.quality_flags.map(String) : [];
      const duplicate = duplicates.has(`doc_id:${doc.arlis_doc_id}`);
      const mergedFlags = mergeReasons(flags, duplicate ? ["duplicate_candidate"] : []);
      if (duplicate) counters.duplicate_candidates_marked++;

      if (doc.needs_human_review === true || mergedFlags.some((f) => ["empty_text", "broken_encoding", "missing_doc_id", "missing_title", "ocr_noise", "short_text"].includes(f))) {
        counters.skipped_review++;
        if (!opts.dryRun && duplicate) {
          await supabase.from("documents")
            .update({ quality_flags: mergedFlags, needs_human_review: true })
            .eq("document_id", doc.document_id);
        }
        continue;
      }

      try {
        const fullText = String(version.full_text ?? "");
        const classification = opts.dryRun
          ? heuristicClassify(doc, fullText)
          : await classifyWithGemini(geminiKey!, opts.model, doc, fullText);
        if (!opts.dryRun) counters.gemini_calls++;

        const profile = {
          document_id: doc.document_id,
          classifier_confidence: classification.confidence,
          classifier_method: opts.dryRun ? "heuristic-dry-run" : opts.model,
          classified_at: new Date().toISOString(),
        };

        if (!opts.dryRun) {
          const updatePayload = {
            content_domain: classification.content_domain,
            normalized_status: classification.normalized_status,
            quality_flags: mergedFlags,
            needs_human_review: mergedFlags.some((flag) =>
              ["empty_text", "broken_encoding", "missing_doc_id", "missing_title", "needs_human_review", "ocr_noise", "short_text"].includes(flag)
            ),
          };
          const { error: updateError } = await supabase.from("documents")
            .update(updatePayload)
            .eq("document_id", doc.document_id);
          if (updateError) throw updateError;

          if (classification.content_domain === "practice") {
            await supabase.from("practice_document_profiles").upsert(profile, { onConflict: "document_id" });
          } else if (classification.content_domain === "knowledge_base") {
            await supabase.from("knowledge_document_profiles").upsert({
              ...profile,
              has_articles: /\bհոդված\b/i.test(fullText),
              has_chapters: /\bգլուխ\b/i.test(fullText),
            }, { onConflict: "document_id" });
          }
        }
        counters.classified++;
      } catch (error) {
        counters.failed++;
        console.error(`[S4] document ${doc.document_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(`[S4] offset=${offset} ${JSON.stringify(counters)}`);
    offset += versions.length;
    if (versions.length < remaining) break;
  }

  console.log(JSON.stringify({ stage: "S4", dry_run: opts.dryRun, model: opts.model, limit: opts.limit ?? null, counters }, null, 2));
}

if (import.meta.main) await run();

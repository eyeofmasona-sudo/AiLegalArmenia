/**
 * S2 ingestion: documents.jsonl -> internal.source_files / internal.extraction_runs.
 *
 * Default is --dry-run. Use --commit to write. Never runs a full import unless the
 * operator explicitly omits --limit.
 *
 * Rules:
 * - Import every JSONL line as raw provenance.
 * - Quarantine is a flag, not a drop path.
 * - Audit hard blockers/review rows are inserted with quarantined=true.
 * - Idempotency: ON CONFLICT(raw_record_sha256) DO NOTHING.
 */

import {
  deriveArlisSourceUrl,
  getMeta,
  loadQuarantineAudit,
  mergeReasons,
  parseCommonArgs,
  readJsonl,
  sha256Hex,
} from "./pipeline_common.ts";
import { asJsonb, connectPipelineDatabase, PipelineDbClient } from "./pipeline_db.ts";

interface CliOptions {
  input: string;
  dryRun: boolean;
  limit?: number;
}

interface Counters {
  total_lines: number;
  valid_json: number;
  invalid_json: number;
  inserted_source_files: number;
  inserted_extraction_runs: number;
  quarantined: number;
  skipped_duplicate: number;
  failed_writes: number;
}

function parseArgs(args: string[]): CliOptions {
  const base = parseCommonArgs(args, { batchSize: 500 }, (arg, index) => {
    if (arg === "--input") return index + 1;
    return undefined;
  });
  const opts: CliOptions = { input: "../documents.jsonl", dryRun: base.dryRun, limit: base.limit };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input") opts.input = args[++i];
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  deno run --allow-read --allow-env --allow-net scripts/ingest_documents_jsonl.ts \\
    --input ../documents.jsonl [--dry-run|--commit] [--limit N]

Aliases: --write == --commit, --max-lines == --limit.
`);
}

function getExtractionStatus(record: Record<string, unknown> | null): "success" | "partial" | "failed" {
  if (!record) return "failed";
  const extraction = typeof record.extraction === "object" && record.extraction !== null
    ? record.extraction as Record<string, unknown>
    : {};
  const status = String(extraction.status ?? "success").toLowerCase();
  if (status === "partial") return "partial";
  if (status === "failed") return "failed";
  return "success";
}

function getExtractionErrors(record: Record<string, unknown> | null, reasons: string[]): unknown[] {
  const extraction = record && typeof record.extraction === "object" && record.extraction !== null
    ? record.extraction as Record<string, unknown>
    : {};
  const errors = Array.isArray(extraction.errors) ? extraction.errors.filter(Boolean) : [];
  return [...errors, ...reasons.map((code) => ({ code }))];
}

async function run() {
  if (Deno.args.includes("--help")) {
    printHelp();
    return;
  }

  const opts = parseArgs(Deno.args);
  const audit = await loadQuarantineAudit();
  const counters: Counters = {
    total_lines: 0,
    valid_json: 0,
    invalid_json: 0,
    inserted_source_files: 0,
    inserted_extraction_runs: 0,
    quarantined: 0,
    skipped_duplicate: 0,
    failed_writes: 0,
  };

  const db = opts.dryRun ? null : await connectPipelineDatabase();

  let jobId: string | null = null;
  if (db) {
    const result = await db.queryObject<{ job_id: string }>(
      `insert into internal.ingestion_jobs (source_file_path, status, report_jsonb)
       values ($1, 'running', $2::jsonb)
       returning job_id::text`,
      [
        opts.input,
        asJsonb({
          stage: "S2",
          mode: "quarantine_as_flag",
          dry_run: false,
          audit_quarantine_records: audit.size,
        }),
      ],
    );
    jobId = result.rows[0]?.job_id ?? null;
  }

  try {
    for await (const { line, lineNumber } of readJsonl(opts.input)) {
      if (opts.limit && counters.total_lines >= opts.limit) break;
      counters.total_lines++;
      if (!line.trim()) continue;

      const rawRecordSha256 = await sha256Hex(line);
      const auditFinding = audit.get(rawRecordSha256);
      const reasons: string[] = [];
      let record: Record<string, unknown> | null = null;

      if (line.includes("\0")) reasons.push("nul_byte");

      try {
        if (!reasons.includes("nul_byte")) {
          record = JSON.parse(line) as Record<string, unknown>;
          counters.valid_json++;
        }
      } catch (error) {
        counters.invalid_json++;
        reasons.push(error instanceof Error ? `json_parse_failed:${error.message.slice(0, 120)}` : "json_parse_failed");
      }

      const meta = record ? getMeta(record) : {};
      const fullText = typeof record?.full_text === "string" ? record.full_text : "";
      const textSha256 = fullText ? await sha256Hex(fullText) : auditFinding?.textSha256 ?? null;
      const mergedReasons = mergeReasons(reasons, auditFinding?.reasons);
      const quarantined = mergedReasons.length > 0;
      if (quarantined) counters.quarantined++;

      if (!db) continue;

      let sourceWriteFailed = false;
      const sourceFile = await insertSourceFile(db, {
        jobId,
        record,
        sourcePath: String(record?.source_path ?? record?.filename ?? opts.input),
        sourceUrl: record ? deriveArlisSourceUrl(record) : null,
        fileSizeBytes: typeof record?.file_size_bytes === "number" ? record.file_size_bytes : null,
        fileSha256: typeof record?.file_sha256 === "string" ? record.file_sha256 : null,
        rawRecordSha256,
        textSha256,
        quarantined,
        quarantineReason: quarantined ? mergedReasons.join(",") : null,
      }).catch((error) => {
        counters.failed_writes++;
        sourceWriteFailed = true;
        console.error(`[S2] source_files line=${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (sourceWriteFailed) continue;
      if (!sourceFile) {
        counters.skipped_duplicate++;
        continue;
      }

      counters.inserted_source_files++;

      try {
        await insertExtractionRun(db, {
          sourceFileId: sourceFile.source_file_id,
          extractionTool: String(meta.extraction_tool ?? "documents-jsonl-s2"),
          extractionStatus: quarantined ? "partial" : getExtractionStatus(record),
          errors: getExtractionErrors(record, mergedReasons),
          traceback: typeof record?.traceback === "string" ? record.traceback : null,
          extractedAt: typeof record?.extracted_at === "string" ? record.extracted_at : null,
        });
        counters.inserted_extraction_runs++;
      } catch (error) {
        counters.failed_writes++;
        console.error(`[S2] extraction_runs line=${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (counters.total_lines % 10000 === 0) console.log(`[S2] ${JSON.stringify(counters)}`);
    }

    if (db && jobId) {
      await finishIngestionJob(db, jobId, "done", { ...counters });
    }
  } catch (error) {
    if (db && jobId) {
      await finishIngestionJob(db, jobId, "failed", {
        ...counters,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    await db?.end();
  }

  console.log(JSON.stringify({ stage: "S2", dry_run: opts.dryRun, input: opts.input, limit: opts.limit ?? null, job_id: jobId, counters }, null, 2));
}

async function insertSourceFile(
  db: PipelineDbClient,
  row: {
    jobId: string | null;
    record: Record<string, unknown> | null;
    sourcePath: string;
    sourceUrl: string | null;
    fileSizeBytes: number | null;
    fileSha256: string | null;
    rawRecordSha256: string;
    textSha256: string | null;
    quarantined: boolean;
    quarantineReason: string | null;
  },
): Promise<{ source_file_id: string } | null> {
  const result = await db.queryObject<{ source_file_id: string }>(
    `insert into internal.source_files (
       job_id, raw_record, source_path, source_url, file_size_bytes, file_sha256,
       raw_record_sha256, text_sha256, quarantined, quarantine_reason
     )
     values (
       $1::uuid, $2::jsonb, $3, $4, $5, $6,
       $7, $8, $9, $10
     )
     on conflict (raw_record_sha256) do nothing
     returning source_file_id::text`,
    [
      row.jobId,
      asJsonb(row.record),
      row.sourcePath,
      row.sourceUrl,
      row.fileSizeBytes,
      row.fileSha256,
      row.rawRecordSha256,
      row.textSha256,
      row.quarantined,
      row.quarantineReason,
    ],
  );
  return result.rows[0] ?? null;
}

async function insertExtractionRun(
  db: PipelineDbClient,
  row: {
    sourceFileId: string;
    extractionTool: string;
    extractionStatus: "success" | "partial" | "failed";
    errors: unknown[];
    traceback: string | null;
    extractedAt: string | null;
  },
): Promise<void> {
  await db.queryObject(
    `insert into internal.extraction_runs (
       source_file_id, extraction_tool, extraction_status, errors, traceback, extracted_at
     )
     values ($1::uuid, $2, $3, $4::jsonb, $5, $6::timestamptz)`,
    [
      row.sourceFileId,
      row.extractionTool,
      row.extractionStatus,
      asJsonb(row.errors),
      row.traceback,
      row.extractedAt,
    ],
  );
}

async function finishIngestionJob(
  db: PipelineDbClient,
  jobId: string,
  status: "done" | "failed",
  report: Record<string, unknown>,
): Promise<void> {
  await db.queryObject(
    `update internal.ingestion_jobs
        set completed_at = now(),
            status = $2,
            total_records = $3,
            failed_records = $4,
            report_jsonb = $5::jsonb,
            updated_at = now()
      where job_id = $1::uuid`,
    [jobId, status, report.total_lines ?? 0, report.failed_writes ?? 0, asJsonb(report)],
  );
}

if (import.meta.main) await run();

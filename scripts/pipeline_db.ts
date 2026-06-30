import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { requireEnv } from "./pipeline_common.ts";

export type PipelineDbClient = Client;

export interface InternalSourceFile {
  source_file_id: string;
  raw_record: Record<string, unknown> | null;
  source_url: string | null;
  text_sha256: string | null;
  quarantined?: boolean;
  quarantine_reason?: string | null;
  job_id?: string | null;
}

export async function connectPipelineDatabase(): Promise<PipelineDbClient> {
  const client = new Client(requireEnv("DATABASE_URL"));
  await client.connect();
  return client;
}

export function asJsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function fetchInternalSourceFiles(
  db: PipelineDbClient,
  opts: { limit: number; offset: number; jobId?: string },
): Promise<InternalSourceFile[]> {
  const result = opts.jobId
    ? await db.queryObject<InternalSourceFile>(
      `select source_file_id::text, raw_record, source_url, text_sha256, quarantined, quarantine_reason, job_id::text
         from internal.source_files
        where quarantined = false
          and job_id = $1::uuid
        order by created_at, source_file_id
        limit $2 offset $3`,
      [opts.jobId, opts.limit, opts.offset],
    )
    : await db.queryObject<InternalSourceFile>(
      `select source_file_id::text, raw_record, source_url, text_sha256, quarantined, quarantine_reason, job_id::text
         from internal.source_files
        where quarantined = false
        order by created_at, source_file_id
        limit $1 offset $2`,
      [opts.limit, opts.offset],
    );

  return result.rows;
}

export async function fetchInternalSourceFileMap(
  db: PipelineDbClient,
  sourceFileIds: string[],
): Promise<Map<string, Pick<InternalSourceFile, "source_url" | "raw_record">>> {
  if (sourceFileIds.length === 0) return new Map();
  const result = await db.queryObject<InternalSourceFile>(
    `select source_file_id::text, source_url, raw_record
       from internal.source_files
      where source_file_id = any(string_to_array($1, ',')::uuid[])`,
    [sourceFileIds.join(",")],
  );
  return new Map(result.rows.map((row) => [row.source_file_id, {
    source_url: row.source_url,
    raw_record: row.raw_record,
  }]));
}

export async function updateInternalSourceUrl(
  db: PipelineDbClient,
  sourceFileId: string,
  sourceUrl: string,
): Promise<void> {
  await db.queryObject(
    `update internal.source_files
        set source_url = $2,
            updated_at = now()
      where source_file_id = $1::uuid`,
    [sourceFileId, sourceUrl],
  );
}

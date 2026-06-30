/**
 * AI LEGAL ARMENIA — Phase 5 Embedding Worker
 * public.search_chunks (pending) → public.embeddings via Cohere embed-multilingual-v3.0
 *
 * Idempotency: ON CONFLICT(chunk_id, model) DO UPDATE WHERE chunk_text_sha256 changed
 * Skips: chunks where embedding exists AND sha256 matches (no re-billing)
 * Failure: marks status='failed', stores error_message
 * Retry: re-processes status='failed' chunks on next run
 *
 * Usage:
 *   deno run --allow-env --allow-net scripts/embed_chunks.ts --dry-run
 *   deno run --allow-env --allow-net scripts/embed_chunks.ts --write [--batch 96] [--force-reembed]
 *
 * Env vars (required for --write):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   COHERE_API_KEY
 *   LEGACY_COHERE_EMBEDDINGS_CONFIRMED=1
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.1";

const COHERE_MODEL = "embed-multilingual-v3.0";
const COHERE_DIM   = 1024;
const MAX_BATCH    = 96;
const MAX_RETRIES  = 5;
const LOG_EVERY    = 1000;

interface CliOptions {
  dryRun: boolean;
  batchSize: number;
  forceReembed: boolean;
}

interface Counters {
  chunks_processed: number;
  embeddings_new: number;
  embeddings_updated: number;
  embeddings_skipped: number;
  embeddings_failed: number;
  api_calls: number;
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = { dryRun: true, batchSize: MAX_BATCH, forceReembed: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--write") opts.dryRun = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--batch") opts.batchSize = Math.min(Number(args[++i]), MAX_BATCH);
    else if (a === "--force-reembed") opts.forceReembed = true;
    else if (a === "--help") { printHelp(); Deno.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  deno run --allow-env --allow-net scripts/embed_chunks.ts [--write] [--batch N] [--force-reembed]

  --write           Embed chunks and write to public.embeddings (default: dry-run)
  --batch N         Chunks per Cohere API call, max ${MAX_BATCH} (default: ${MAX_BATCH})
  --force-reembed   Re-embed even if status=success (ignores sha256 guard)

Env vars:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COHERE_API_KEY, LEGACY_COHERE_EMBEDDINGS_CONFIRMED=1
`);
}

async function cohereEmbed(
  texts: string[],
  inputType: "search_document" | "search_query",
  apiKey: string,
): Promise<number[][]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch("https://api.cohere.com/v1/embed", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        texts,
        model: COHERE_MODEL,
        input_type: inputType,
      }),
    });

    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after") ?? 2 ** attempt);
      console.warn(`[cohere] rate limited, waiting ${retryAfter}s (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Cohere API ${resp.status}: ${body.slice(0, 300)}`);
    }

    const json = await resp.json() as { embeddings: number[][] };
    if (!json.embeddings || json.embeddings[0]?.length !== COHERE_DIM) {
      throw new Error(`Unexpected embedding dimension: ${json.embeddings?.[0]?.length}`);
    }
    return json.embeddings;
  }
  throw new Error(`Cohere max retries (${MAX_RETRIES}) exceeded`);
}

async function run() {
  const opts = parseArgs(Deno.args);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cohereKey   = Deno.env.get("COHERE_API_KEY");
  const legacyCohereConfirmed = Deno.env.get("LEGACY_COHERE_EMBEDDINGS_CONFIRMED") === "1";

  if (!opts.dryRun && !legacyCohereConfirmed) {
    throw new Error(
      "Refusing Cohere embedding writes. Unified corpus retrieval indexes expect Metric-AI/Qwen model labels. Set LEGACY_COHERE_EMBEDDINGS_CONFIRMED=1 only after manually confirming this legacy path is intended.",
    );
  }

  if (!opts.dryRun && (!supabaseUrl || !serviceKey || !cohereKey)) {
    throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COHERE_API_KEY, LEGACY_COHERE_EMBEDDINGS_CONFIRMED=1 required with --write");
  }

  const supabase = supabaseUrl && serviceKey
    ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
    : null;

  const counters: Counters = {
    chunks_processed: 0,
    embeddings_new: 0,
    embeddings_updated: 0,
    embeddings_skipped: 0,
    embeddings_failed: 0,
    api_calls: 0,
  };

  if (opts.dryRun || !supabase || !cohereKey) {
    if (supabase) {
      const { count } = await supabase.from("search_chunks")
        .select("chunk_id", { count: "exact", head: true });
      const { count: pendingCount } = await supabase.from("embeddings")
        .select("embedding_id", { count: "exact", head: true })
        .eq("status", "pending");
      const { count: failedCount } = await supabase.from("embeddings")
        .select("embedding_id", { count: "exact", head: true })
        .eq("status", "failed");
      console.log(JSON.stringify({
        dry_run: true,
        total_chunks: count,
        pending_embeddings: pendingCount,
        failed_embeddings: failedCount,
        estimated_cost_usd: `~$${((count ?? 0) * 500 * 0.0001 / 1000).toFixed(2)} (avg 500 tokens/chunk)`,
      }, null, 2));
    } else {
      console.log("[dry-run] No DB connection. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    }
    return;
  }

  let offset = 0;
  while (true) {
    let query = supabase.from("search_chunks")
      .select(`
        chunk_id, text, chunk_text_sha256,
        embeddings!left(embedding_id, status, chunk_text_sha256, model)
      `)
      .range(offset, offset + opts.batchSize - 1);

    if (!opts.forceReembed) {
      query = query.or(
        `embeddings.is.null,` +
        `embeddings.status.eq.pending,` +
        `embeddings.status.eq.failed`
      );
    }

    const { data: chunks, error: cErr } = await query;
    if (cErr) throw new Error(`search_chunks fetch: ${cErr.message}`);
    if (!chunks || chunks.length === 0) break;

    const pendingChunks = chunks.filter((c) => {
      const emb = Array.isArray(c.embeddings) ? c.embeddings[0] : c.embeddings;
      if (!emb) return true;
      if (opts.forceReembed) return true;
      if (emb.status === "failed" || emb.status === "pending") return true;
      return emb.chunk_text_sha256 !== c.chunk_text_sha256;
    });

    counters.chunks_processed += chunks.length;
    counters.embeddings_skipped += chunks.length - pendingChunks.length;

    if (pendingChunks.length === 0) {
      offset += opts.batchSize;
      continue;
    }

    let vectors: number[][];
    try {
      vectors = await cohereEmbed(
        pendingChunks.map((c) => c.text),
        "search_document",
        cohereKey,
      );
      counters.api_calls++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[cohere] batch error: ${errMsg}`);
      for (const c of pendingChunks) {
        await supabase.from("embeddings").upsert(
          {
            chunk_id: c.chunk_id,
            model: COHERE_MODEL,
            dimension: COHERE_DIM,
            vector: null,
            chunk_text_sha256: c.chunk_text_sha256,
            status: "failed",
            error_message: errMsg.slice(0, 500),
          },
          { onConflict: "chunk_id, model" },
        );
        counters.embeddings_failed++;
      }
      offset += opts.batchSize;
      continue;
    }

    for (let i = 0; i < pendingChunks.length; i++) {
      const c = pendingChunks[i];
      const vec = vectors[i];
      const { error: uErr } = await supabase.from("embeddings").upsert(
        {
          chunk_id: c.chunk_id,
          model: COHERE_MODEL,
          dimension: COHERE_DIM,
          vector: `[${vec.join(",")}]`,
          chunk_text_sha256: c.chunk_text_sha256,
          status: "success",
          error_message: null,
        },
        { onConflict: "chunk_id, model" },
      );

      if (uErr) {
        counters.embeddings_failed++;
        console.error(`[embed] chunk ${c.chunk_id}: ${uErr.message}`);
      } else {
        const emb = Array.isArray(c.embeddings) ? c.embeddings[0] : c.embeddings;
        if (!emb) counters.embeddings_new++;
        else counters.embeddings_updated++;
      }
    }

    if (counters.chunks_processed % LOG_EVERY < opts.batchSize) {
      console.log(`[phase5] processed=${counters.chunks_processed} ${JSON.stringify(counters)}`);
    }

    offset += opts.batchSize;
    if (chunks.length < opts.batchSize) break;
  }

  console.log(JSON.stringify({ dryRun: opts.dryRun, model: COHERE_MODEL, counters }, null, 2));
}

if (import.meta.main) {
  await run();
}

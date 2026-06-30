import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

type GoldItem = {
  document_id?: string | null;
  chunk_id?: string | null;
  citation_anchor?: string | null;
};

type ResultItem = {
  document_id?: string | null;
  chunk_id?: string | null;
  citation_anchor?: string | null;
  score?: number | null;
};

type EvalRow = {
  query_id: string;
  query: string;
  gold: GoldItem[];
  results?: ResultItem[];
};

type Args = {
  evalPath: string | null;
  k: number;
  write: boolean;
  allowProduction: boolean;
  datasetName: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    evalPath: null,
    k: 10,
    write: false,
    allowProduction: false,
    datasetName: "phase0_rag_eval",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--eval") args.evalPath = argv[++i] ?? null;
    else if (arg === "--k") args.k = Number(argv[++i] ?? "10");
    else if (arg === "--write") args.write = true;
    else if (arg === "--allow-production") args.allowProduction = true;
    else if (arg === "--dataset") args.datasetName = argv[++i] ?? args.datasetName;
  }
  return args;
}

function key(item: GoldItem | ResultItem): string {
  return [
    item.chunk_id ?? "",
    item.document_id ?? "",
    (item.citation_anchor ?? "").trim().toLowerCase(),
  ].join("|");
}

function isMatch(result: ResultItem, gold: GoldItem[]): boolean {
  const resultKey = key(result);
  return gold.some((item) => key(item) === resultKey);
}

function metrics(rows: EvalRow[], k: number) {
  let recallSum = 0;
  let precisionSum = 0;
  let reciprocalRankSum = 0;

  for (const row of rows) {
    const goldKeys = new Set(row.gold.map(key));
    const top = (row.results ?? []).slice(0, k);
    const hits = top.filter((result) => isMatch(result, row.gold));
    recallSum += goldKeys.size > 0 ? hits.length / goldKeys.size : 0;
    precisionSum += top.length > 0 ? hits.length / top.length : 0;
    const firstHit = top.findIndex((result) => isMatch(result, row.gold));
    reciprocalRankSum += firstHit >= 0 ? 1 / (firstHit + 1) : 0;
  }

  const count = rows.length || 1;
  return {
    query_count: rows.length,
    recall: recallSum / count,
    precision: precisionSum / count,
    mrr: reciprocalRankSum / count,
  };
}

async function readJsonl(path: string): Promise<EvalRow[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRow);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.evalPath) {
    throw new Error("--eval path is required. Dry-run is the default; pass --write --allow-production to persist.");
  }

  const rows = await readJsonl(args.evalPath);
  const summary = metrics(rows, args.k);
  const dryRun = !args.write;

  if (args.write) {
    if (!args.allowProduction) {
      throw new Error("--write requires --allow-production so production Supabase is never touched accidentally.");
    }
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required with --write.");
    }
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: dataset, error: datasetError } = await supabase
      .schema("internal")
      .from("rag_eval_datasets")
      .upsert({ name: args.datasetName }, { onConflict: "name" })
      .select("dataset_id")
      .single();
    if (datasetError) throw datasetError;

    const { error: runError } = await supabase
      .schema("internal")
      .from("rag_eval_runs")
      .insert({
        dataset_id: dataset.dataset_id,
        dry_run: false,
        retrieval_config: { k: args.k, source: args.evalPath },
        recall: summary.recall,
        precision: summary.precision,
        mrr: summary.mrr,
        query_count: summary.query_count,
        completed_at: new Date().toISOString(),
      });
    if (runError) throw runError;
  }

  console.log(JSON.stringify({ dry_run: dryRun, k: args.k, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

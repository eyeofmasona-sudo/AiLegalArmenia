export interface CommonCliOptions {
  dryRun: boolean;
  batchSize: number;
  limit?: number;
}

export interface AuditFinding {
  reasons: string[];
  docId?: string;
  textSha256?: string;
  lineNumber?: number;
}

const encoder = new TextEncoder();
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const ARMENIAN_RE = /[\u0530-\u058f]/;
const MOJIBAKE_MARKERS_RE = /[Г•Г–Г”Г‚ГѓГђГ‘][\x80-\xffA-Za-zВ±ВµВєВјВЅВѕВї]*/g;
const ARMENIAN_AS_CYRILLIC_MOJIBAKE_RE = /[РҐР¤Р¦РЃРЋТђР‡Р…Р‹С’Т‘]{2,}/g;
const ARMENIAN_AS_CYRILLIC_MARKERS = new Set("РҐР¤Р¦РЃРЋТђР‡Р…Р‹С’Т‘".split(""));

export const HARD_BLOCKER_REASONS = new Set([
  "empty_text",
  "missing_doc_id",
]);

export const REVIEW_REASONS = new Set([
  "broken_encoding",
  "missing_title",
  "needs_human_review",
  "ocr_noise",
  "short_text",
]);

export function parseCommonArgs(
  args: string[],
  defaults: { batchSize: number; limit?: number },
  extra?: (arg: string, index: number, args: string[]) => number | void,
): CommonCliOptions {
  const opts: CommonCliOptions = { dryRun: true, batchSize: defaults.batchSize, limit: defaults.limit };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--commit" || a === "--write") opts.dryRun = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--batch") opts.batchSize = Number(args[++i]);
    else if (a === "--limit" || a === "--max-lines") opts.limit = Number(args[++i]);
    else if (a === "--help") continue;
    else if (extra) {
      const next = extra(a, i, args);
      if (typeof next === "number") i = next;
      else if (next === undefined) throw new Error(`Unknown argument: ${a}`);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function* readJsonl(path: string): AsyncGenerator<{ line: string; lineNumber: number }> {
  const file = await Deno.open(path, { read: true });
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1024 * 1024);
  let pending = "";
  let lineNumber = 0;
  try {
    while (true) {
      const n = await file.read(buffer);
      if (n === null) break;
      pending += decoder.decode(buffer.subarray(0, n), { stream: true });
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        lineNumber++;
        yield { line: pending.slice(0, idx).replace(/\r$/, ""), lineNumber };
        pending = pending.slice(idx + 1);
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) {
      lineNumber++;
      yield { line: pending.replace(/\r$/, ""), lineNumber };
    }
  } finally {
    file.close();
  }
}

export async function loadQuarantineAudit(path = "../reports/quarantine_candidates.jsonl"): Promise<Map<string, AuditFinding>> {
  const findings = new Map<string, AuditFinding>();
  try {
    for await (const { line } of readJsonl(path)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      const hash = String(row.raw_record_sha256 ?? "");
      if (!hash) continue;
      const reasons = Array.isArray(row.reasons)
        ? row.reasons.map(String)
        : [String(row.reason ?? "audit_quarantine")];
      findings.set(hash, {
        reasons,
        docId: typeof row.doc_id === "string" ? row.doc_id : undefined,
        textSha256: typeof row.text_sha256 === "string" ? row.text_sha256 : undefined,
        lineNumber: typeof row.line_number === "number" ? row.line_number : undefined,
      });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return findings;
}

export async function loadDuplicateAudit(path = "../reports/duplicate_candidates.jsonl"): Promise<Map<string, AuditFinding>> {
  const findings = new Map<string, AuditFinding>();
  try {
    for await (const { line } of readJsonl(path)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      const docId = typeof row.doc_id === "string" ? row.doc_id : undefined;
      const lineNumber = typeof row.line_number === "number" ? row.line_number : undefined;
      const key = docId ? `doc_id:${docId}` : lineNumber ? `line:${lineNumber}` : "";
      if (!key) continue;
      findings.set(key, {
        reasons: ["duplicate_candidate"],
        docId,
        lineNumber,
      });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return findings;
}

export function getMeta(record: Record<string, unknown>): Record<string, unknown> {
  return typeof record.metadata === "object" && record.metadata !== null
    ? record.metadata as Record<string, unknown>
    : {};
}

export function getArlisDocId(record: Record<string, unknown>): string {
  const meta = getMeta(record);
  return String(meta.arlis_doc_id ?? meta.doc_id ?? record.doc_id ?? "").trim();
}

export function deriveArlisSourceUrl(record: Record<string, unknown>): string | null {
  const meta = getMeta(record);
  const explicit = meta.source_url ?? record.source_url;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  const arlisId = getArlisDocId(record);
  if (arlisId) return `https://www.arlis.am/DocumentView.aspx?DocID=${encodeURIComponent(arlisId)}`;

  const fullText = typeof record.full_text === "string" ? record.full_text : "";
  const match = fullText.match(/https?:\/\/(?:www\.)?arlis\.am\/DocumentView\.aspx\?DocID=(\d+)/i);
  if (match?.[1]) return `https://www.arlis.am/DocumentView.aspx?DocID=${match[1]}`;

  const anyDocId = fullText.match(/\bDocID=(\d{2,})\b/i);
  return anyDocId?.[1] ? `https://www.arlis.am/DocumentView.aspx?DocID=${anyDocId[1]}` : null;
}

export function normalizeStatus(raw: unknown): { normalized: "active" | "repealed" | "partially_active" | "draft" | "unknown"; dirty: boolean } {
  if (typeof raw !== "string" || !raw.trim()) return { normalized: "unknown", dirty: false };
  const v = raw.trim().toLowerCase();
  if (v.includes("գործում") || v.includes("active")) return { normalized: "active", dirty: false };
  if (v.includes("չի գործում") || v.includes("ուժը կորց") || v.includes("repeal")) return { normalized: "repealed", dirty: false };
  if (v.includes("մասնակի") || v.includes("partial")) return { normalized: "partially_active", dirty: false };
  if (v.includes("draft") || v.includes("նախագիծ")) return { normalized: "draft", dirty: false };
  return { normalized: "unknown", dirty: true };
}

export function parseDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parts = raw.trim().split(".");
  if (parts.length === 3) {
    const [d, m, y] = parts;
    if (d && m && y && y.length === 4) return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const iso = Date.parse(raw);
  return Number.isNaN(iso) ? null : new Date(iso).toISOString().split("T")[0];
}

export function mergeReasons(...groups: Array<Array<string | null | undefined> | undefined>): string[] {
  const out = new Set<string>();
  for (const group of groups) {
    for (const item of group ?? []) {
      if (item) out.add(item);
    }
  }
  return [...out].sort();
}

export function hasHardBlockerOrReview(reasons: string[]): boolean {
  return reasons.some((reason) => HARD_BLOCKER_REASONS.has(reason) || REVIEW_REASONS.has(reason));
}

export function detectTextQualityFlags(text: string): string[] {
  const stripped = text.trim();
  if (!stripped) return ["empty_text"];

  const flags: string[] = [];
  if (stripped.length < 300) flags.push("short_text");

  const sample = stripped.slice(0, 200_000);
  const replacementCount = (sample.match(/\ufffd/g) ?? []).length;
  const controlCount = (sample.match(CONTROL_RE) ?? []).length;
  const mojibakeCount = (sample.match(MOJIBAKE_MARKERS_RE) ?? []).length;
  const cyrRuns = (sample.match(ARMENIAN_AS_CYRILLIC_MOJIBAKE_RE) ?? []).length;
  const sampleChars = Math.max(1, sample.replace(/\s+/g, "").length);
  let cyrMarkerChars = 0;
  for (const ch of sample) if (ARMENIAN_AS_CYRILLIC_MARKERS.has(ch)) cyrMarkerChars++;

  if (
    replacementCount > 0 ||
    controlCount > 0 ||
    mojibakeCount >= 20 ||
    (cyrRuns >= 20 && cyrMarkerChars / sampleChars > 0.15 && !ARMENIAN_RE.test(sample))
  ) {
    flags.push("broken_encoding");
  }

  const noisyChars = (sample.match(/[^\w\s\u0530-\u058f\u0400-\u04ff.,;:!?()[\]{}"'`/\\\-вЂ–вЂ”В«В»в„–%+*=<>]/g) ?? []).length;
  if (noisyChars / sampleChars > 0.08) flags.push("ocr_noise");

  return mergeReasons(flags);
}

export const LEGACY_WRITE_DISABLED =
  "Legacy knowledge_base/legal_practice_kb pipelines are disabled for the live unified corpus. Use the documents/search_chunks/embeddings ingestion pipeline after explicit live reconciliation.";

export function legacyDisabledResponse(corsHeaders?: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      error: LEGACY_WRITE_DISABLED,
      disabled: true,
    }),
    {
      status: 410,
      headers: { ...(corsHeaders ?? {}), "Content-Type": "application/json" },
    },
  );
}

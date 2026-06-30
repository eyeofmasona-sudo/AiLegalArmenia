export const LEGACY_RETRIEVAL_UNSUPPORTED =
  'Legacy knowledge_base/legal_practice_kb writes are disabled after the unified corpus migration. Use the documents/search_chunks/embeddings ingestion pipeline after live migrations and DB type regeneration.';

export function legacyRetrievalUnsupported(): Error {
  return new Error(LEGACY_RETRIEVAL_UNSUPPORTED);
}

-- AI LEGAL ARMENIA — Dual Index Retrieval: separate ANN index per embedding provider.
-- Rule: Metric (Armenian hy) and Qwen (ECHR en/fr) MUST NOT share one vector index.
-- One embeddings table (vector(1024)), two PARTIAL HNSW indexes filtered by model.
--
-- APPLY ONLY AFTER both embedding runs complete (HNSW build is heavy on full corpus).
-- During embedding, keep the table index-free for fast inserts.

drop index if exists public.embeddings_hnsw_idx;

-- Metric-AI Armenian index (Corpus A, language hy)
create index if not exists embeddings_hnsw_metric_idx
  on public.embeddings using hnsw (vector vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where model = 'armenian-text-embeddings-2-large';

-- Qwen3-0.6B index (Corpus B, ECHR en/fr)
create index if not exists embeddings_hnsw_qwen_idx
  on public.embeddings using hnsw (vector vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where model = 'qwen3-embedding-0.6b';

comment on index public.embeddings_hnsw_metric_idx is
  'Dual Index — Metric-AI armenian-text-embeddings-2-large, Armenian corpus (hy). Cosine HNSW.';
comment on index public.embeddings_hnsw_qwen_idx is
  'Dual Index — Qwen3-Embedding-0.6B, ECHR corpus (en/fr). Cosine HNSW. Separate from Metric.';

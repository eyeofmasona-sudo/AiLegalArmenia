# AI Legal Armenia

AI Legal Armenia is a cloud-based legal assistance platform for Armenian legal workflows.

## Stack

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS
- Supabase Auth, Postgres, Storage, and Edge Functions

## Local Setup

1. Install dependencies:

```sh
npm i
```

2. Copy `.env.example` to `.env` and insert values from the new Supabase project.

3. Start the development server:

```sh
npm run dev
```

## Supabase Configuration

Required client variables:

```sh
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

Required server/script variables:

```sh
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
INTERNAL_INGEST_KEY
CRON_WORKER_KEY
OPENAI_API_KEY
OPENROUTER_API_KEY
AI_PROVIDER
```

The bundled edge-function model registry uses Claude/Gemini model IDs for legal analysis, so set `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY` for production AI calls. OpenAI remains required for embeddings and explicitly OpenAI-only utility models.

Unified corpus search also requires these server-side values when vector search is enabled:

```sh
EMBEDDING_MODEL
EMBEDDING_DB_MODEL
EMBEDDING_DIM
EMBEDDING_BATCH
EMBEDDING_ENDPOINT
EMBEDDING_API_KEY
```

Live Supabase migration, type generation, ingestion, embedding, and smoke-test steps are documented in `docs/UNIFIED_CORPUS_LIVE_STEPS.md`.

Legacy `knowledge_base` / `legal_practice_kb` import and admin write paths are disabled locally until a verified mapping into `documents`, `document_versions`, `search_chunks`, and `embeddings` is defined from live schema evidence.

Corpus population scripts are available as:

```sh
npm run pipeline:s2
npm run pipeline:s3
npm run pipeline:s4
npm run pipeline:s5
```

## Verification

```sh
npm run lint
npm run build
npx tsc -p tsconfig.app.json --noEmit
```

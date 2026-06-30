# VPS Embeddings / RAG — Exactly What To Run

**Audience:** deploying the embedding service that powers semantic search for AI Legal Armenia.
**Date:** 2026-06-27. Verified against live project `avmgtsonawtzebvazgcr`.

## TL;DR — the one thing that breaks embeddings

The Supabase **edge functions** `vector-search` and `embed-query` generate the *query* vector by
calling `EMBEDDING_ENDPOINT/embed/query`. Those functions run on **Supabase's** servers, not on your
VPS. So `EMBEDDING_ENDPOINT` **must be a public HTTPS URL** that reaches your VPS. `http://127.0.0.1:8088`
(the value currently in `.env`) works only for local scripts and is unreachable from the edge → every
query silently falls back to BM25 keyword search (no semantic recall, but no visible error).

---

## What must run on the VPS (always-on)

| # | Service | Purpose | Always-on? | Port | Health |
|---|---------|---------|-----------|------|--------|
| 1 | **Embedding server** (`scripts/embedding_server.py`, FastAPI/uvicorn) | Embeds the **query** with the SAME model as indexed passages (`Metric-AI/armenian-text-embeddings-2-large`, 1024-dim, `query:` prefix) | **YES** — semantic search is dead without it | 8088 (bind 127.0.0.1) | `GET /health` → `{status, model, dimension:1024}` |
| 2 | **Reverse proxy** (Nginx or Caddy, TLS) | Exposes #1 publicly over HTTPS so Supabase edge can reach it; terminates TLS; enforces API key | **YES** | 443 | proxies `/health` |

Everything else (ingestion workers `practice-embed-worker`, `pipeline-tick` cron, etc.) already runs as
**Supabase edge functions** — nothing to host on the VPS for those. The VPS is needed **only** for the
query-embedding model (and any offline re-embedding batch jobs you run from the box).

> If you also want **ECHR semantic search** (the qwen3 path), you need a *second* model server for
> `qwen3-embedding-0.6b` — see "Known gap H1" at the bottom. Without it, ECHR is keyword-only today.

---

## Step 1 — install & run the embedding server

```bash
# On the VPS (Ubuntu). Python 3.10+.
cd /opt/ailegal/scripts            # where embedding_server.py + embeddings_provider.py live
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi "uvicorn[standard]" sentence-transformers torch

export EMBEDDING_MODEL="Metric-AI/armenian-text-embeddings-2-large"
export EMBEDDING_API_KEY="<long-random-secret>"     # shared with Supabase
# export EMBEDDING_DEVICE=cuda                       # only if the VPS has a GPU
uvicorn embedding_server:app --host 127.0.0.1 --port 8088
# First start downloads ~1–2 GB of model weights; needs ~2–4 GB RAM free.
curl -s 127.0.0.1:8088/health        # expect dimension: 1024
```

### systemd unit (`/etc/systemd/system/ailegal-embeddings.service`)

```ini
[Unit]
Description=AI Legal Armenia embedding server
After=network-online.target
Wants=network-online.target

[Service]
User=ailegal
WorkingDirectory=/opt/ailegal/scripts
Environment=EMBEDDING_MODEL=Metric-AI/armenian-text-embeddings-2-large
Environment=EMBEDDING_API_KEY=<long-random-secret>
# Environment=EMBEDDING_DEVICE=cuda
ExecStart=/opt/ailegal/scripts/.venv/bin/uvicorn embedding_server:app --host 127.0.0.1 --port 8088
Restart=always
RestartSec=5
TimeoutStartSec=600          # allow first-run model download

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ailegal-embeddings
sudo systemctl status ailegal-embeddings
```

## Step 2 — public HTTPS via Nginx

```nginx
# /etc/nginx/sites-available/embeddings
server {
  listen 443 ssl;
  server_name embeddings.ailegalarmenia.com;
  ssl_certificate     /etc/letsencrypt/live/embeddings.ailegalarmenia.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/embeddings.ailegalarmenia.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_set_header Host $host;
    proxy_read_timeout 60s;
    client_max_body_size 1m;
  }
}
```

```bash
sudo certbot --nginx -d embeddings.ailegalarmenia.com
curl -s https://embeddings.ailegalarmenia.com/health    # must return dimension 1024 from outside
```

The API key (`X-API-Key`) is the access control. Optionally also restrict the firewall to Supabase
egress ranges, but the shared secret is the primary guard.

## Step 3 — point Supabase at it (the critical wiring)

In **Supabase Dashboard → Edge Functions → Secrets**, set:

```
EMBEDDING_ENDPOINT = https://embeddings.ailegalarmenia.com
EMBEDDING_API_KEY  = <same long-random-secret as the VPS>
```

(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` are auto-injected — do not re-add.)

## Step 4 — verify end-to-end (not just /health)

```bash
# 1. Query embedding from outside (proves edge can reach VPS):
curl -s -X POST https://embeddings.ailegalarmenia.com/embed/query \
  -H "Content-Type: application/json" -H "X-API-Key: <secret>" \
  -d '{"texts":"որակել սպանություն"}' | python3 -c "import sys,json;print('dim',len(json.load(sys.stdin)['vectors'][0]))"
# expect: dim 1024

# 2. Then run any AI feature in the app and confirm the response telemetry shows
#    retrieval_mode = "vector" or "hybrid" (NOT "keyword_only"/"rpc_fallback")
#    and semantic_ok = true. These are returned by vector-search.
```

If `retrieval_mode` is `keyword_only`/`rpc_fallback` or `semantic_ok=false`, the edge still can't reach
the endpoint (DNS, TLS, firewall, or the secret) — fix that before declaring embeddings "working".

---

## What breaks if each piece is down

- **Embedding server (8088) down / model not loaded** → `/embed/query` 5xx → edge gets no vector →
  semantic search OFF, BM25 only. App keeps working but answers lose precedent/semantic recall.
- **Reverse proxy / DNS / cert wrong** → edge fetch fails (timeout/TLS) → same BM25 fallback.
- **`EMBEDDING_ENDPOINT` left as 127.0.0.1 in edge secrets** → same BM25 fallback (this is the current trap).
- **Wrong/missing `EMBEDDING_API_KEY`** → 401 from server → BM25 fallback.

The fallback is *silent and graceful* by design, which is why a misconfigured endpoint looks like
"embeddings work" while semantic quality is actually gone. Always check the telemetry in Step 4.

---

## Known gap H1 — ECHR (qwen3) semantic search is currently disabled

The corpus has **162,206** ECHR (en/fr) chunks embedded with `qwen3-embedding-0.6b`, but:
- `vector-search/index.ts` passes `p_qwen_embedding: null` and `p_qwen_limit: 0`; and
- there is **no ANN index** on the qwen vectors in production.

So ECHR is retrieved by **BM25 only**. To enable ECHR semantic search you must either:
1. **Run a second model server** for `qwen3-embedding-0.6b`, wire `vector-search` to embed the query
   with it and pass `p_qwen_embedding`/`p_qwen_limit>0`, and create
   `embeddings_hnsw_qwen_idx` (or an ivfflat partial index) `WHERE model='qwen3-embedding-0.6b'`; **or**
2. **Re-embed those 162k ECHR chunks with the Armenian model** (one model end-to-end), which removes the
   second server entirely and lets the existing metric index + `p_metric` path cover ECHR.

Option 2 is simpler to operate (one model, one server) and is the recommended path unless qwen
materially improves ECHR (en/fr) recall. Either requires the embedding server above to be running first.

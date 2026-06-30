"""
AI LEGAL ARMENIA — embedding HTTP service (FastAPI).

Why: vector search needs a query vector, but Supabase Edge Functions run on Deno
and cannot load sentence-transformers. This tiny service exposes the SAME model
(Metric-AI/armenian-text-embeddings-2-large) over HTTP so the search layer can embed
queries with identical semantics to the indexed passages.

Run:
    pip install fastapi uvicorn sentence-transformers
    set EMBEDDING_MODEL=Metric-AI/armenian-text-embeddings-2-large
    uvicorn embedding_server:app --host 127.0.0.1 --port 8088

Endpoints:
    GET  /health                      -> {"status","model","dimension"}
    POST /embed/query   {"texts":[..]}-> {"model","dimension","vectors":[[...]]}  (query: prefix)
    POST /embed/passage {"texts":[..]}-> {"model","dimension","vectors":[[...]]}  (passage: prefix)

Auth (optional): set EMBEDDING_API_KEY and send header  X-API-Key: <key>.
"""

from __future__ import annotations

import os
from typing import List, Union

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from embeddings_provider import get_provider, EmbeddingError

API_KEY = os.environ.get("EMBEDDING_API_KEY")  # optional shared secret
app = FastAPI(title="AI Legal Armenia — Embeddings", version="2.0")


class EmbedRequest(BaseModel):
    texts: Union[str, List[str]]


def _check_auth(x_api_key: str | None) -> None:
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


def _as_list(v) -> List[List[float]]:
    # provider returns List[float] for a single string, List[List[float]] for a list
    return [v] if v and isinstance(v[0], float) else v


@app.get("/health")
def health():
    try:
        p = get_provider()
        return {"status": "ok", "model": p.model_name, "dimension": p.dimension}
    except EmbeddingError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/embed/query")
def embed_query(req: EmbedRequest, x_api_key: str | None = Header(default=None)):
    _check_auth(x_api_key)
    try:
        p = get_provider()
        vecs = _as_list(p.embed_query(req.texts))
        return {"model": p.model_name, "dimension": p.dimension, "vectors": vecs}
    except EmbeddingError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embed/passage")
def embed_passage(req: EmbedRequest, x_api_key: str | None = Header(default=None)):
    _check_auth(x_api_key)
    try:
        p = get_provider()
        vecs = _as_list(p.embed_passages(req.texts))
        return {"model": p.model_name, "dimension": p.dimension, "vectors": vecs}
    except EmbeddingError as e:
        raise HTTPException(status_code=500, detail=str(e))

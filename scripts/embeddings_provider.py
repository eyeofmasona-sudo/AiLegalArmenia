"""
AI LEGAL ARMENIA — Embedding provider (Hugging Face Transformers, e5 family).

Single source of truth for turning legal text into vectors. Used by:
  * indexing worker (embed_armenian.py)        -> "passage: " prefix
  * query-time embedding service (FastAPI)      -> "query: "   prefix

Model: Metric-AI/armenian-text-embeddings-2-large
  - Armenian Text Embeddings 2 (large), v2.0, base: intfloat/multilingual-e5-large
  - 1024-dim, cosine similarity -> L2-normalized vectors
  - used for the Armenian legal corpus only in production retrieval.
    ECHR EN/FR uses the separate Qwen3-Embedding-0.6B index.
  - e5 requires prefixes: "query: " for queries, "passage: " for documents.

Implementation note: we use `transformers` (AutoModel) + mean pooling directly
instead of `sentence-transformers`, to avoid the optional torchcodec/FFmpeg
dependency that breaks sentence-transformers import on some setups.

ENV:
  EMBEDDING_MODEL   (default Metric-AI/armenian-text-embeddings-2-large)
  EMBEDDING_DEVICE  (cpu | cuda; default auto)
  EMBEDDING_DIM     (expected dim, default 1024 — validated on load)
  EMBEDDING_MAXLEN  (token truncation, default 512)
"""

from __future__ import annotations

import os
import threading
from typing import List, Sequence, Union

# All HF models/cache live on D:\AI_MODELS (never C:). Set before transformers import.
_HF = os.environ.get("HF_HOME") or r"D:\AI_MODELS\HF_CACHE"
os.environ.setdefault("HF_HOME", _HF)
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", _HF)
os.environ.setdefault("TRANSFORMERS_CACHE", _HF)
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
try:
    os.makedirs(_HF, exist_ok=True)
except Exception:
    pass

DEFAULT_MODEL = "Metric-AI/armenian-text-embeddings-2-large"
DEFAULT_DIM = 1024
DEFAULT_MAXLEN = 512

DB_MODEL_NAME = os.environ.get("EMBEDDING_DB_MODEL", "armenian-text-embeddings-2-large")


class EmbeddingError(RuntimeError):
    """Raised for any failure while loading the model or encoding text."""


class EmbeddingProvider:
    """Thread-safe lazy wrapper around an e5 model loaded via transformers."""

    def __init__(self, model_name=None, device=None, expected_dim=None,
                 normalize=True, max_len=None):
        self.model_name = model_name or os.environ.get("EMBEDDING_MODEL", DEFAULT_MODEL)
        self.device = device or os.environ.get("EMBEDDING_DEVICE") or None
        self.expected_dim = expected_dim or int(os.environ.get("EMBEDDING_DIM", DEFAULT_DIM))
        self.max_len = max_len or int(os.environ.get("EMBEDDING_MAXLEN", DEFAULT_MAXLEN))
        self.normalize = normalize
        self._tok = None
        self._model = None
        self._torch = None
        self._lock = threading.Lock()

    def _load(self):
        try:
            import torch
            from transformers import AutoTokenizer, AutoModel
        except ImportError as e:
            raise EmbeddingError("transformers/torch not installed: %s" % e) from e
        try:
            tok = AutoTokenizer.from_pretrained(self.model_name)
            model = AutoModel.from_pretrained(self.model_name)
            model.eval()
            dev = self.device or ("cuda" if torch.cuda.is_available() else "cpu")
            model.to(dev)
            self.device = dev
        except Exception as e:
            raise EmbeddingError("Failed to load model '%s': %s" % (self.model_name, e)) from e
        dim = int(model.config.hidden_size)
        if self.expected_dim and dim != self.expected_dim:
            raise EmbeddingError(
                "Model '%s' dim=%d but EMBEDDING_DIM=%d (schema vector(%d))."
                % (self.model_name, dim, self.expected_dim, self.expected_dim))
        self._torch, self._tok, self._model = torch, tok, model
        return model

    def _ensure(self):
        if self._model is None:
            with self._lock:
                if self._model is None:
                    self._load()

    @property
    def dimension(self) -> int:
        self._ensure()
        return int(self._model.config.hidden_size)

    @staticmethod
    def _clean(text: str) -> str:
        return (text or "").replace("\x00", "").strip()

    def _encode(self, prefixed: Sequence[str], batch_size: int = 32) -> List[List[float]]:
        if not prefixed:
            return []
        self._ensure()
        torch = self._torch
        out: List[List[float]] = []
        try:
            with torch.no_grad():
                for i in range(0, len(prefixed), batch_size):
                    batch = list(prefixed[i:i + batch_size])
                    enc = self._tok(batch, padding=True, truncation=True,
                                    max_length=self.max_len, return_tensors="pt").to(self.device)
                    model_out = self._model(**enc)
                    hidden = model_out.last_hidden_state           # (B, T, H)
                    mask = enc["attention_mask"].unsqueeze(-1).type_as(hidden)
                    summed = (hidden * mask).sum(dim=1)
                    counts = mask.sum(dim=1).clamp(min=1e-9)
                    emb = summed / counts                           # mean pooling
                    if self.normalize:
                        emb = torch.nn.functional.normalize(emb, p=2, dim=1)
                    out.extend(emb.cpu().tolist())
        except Exception as e:
            raise EmbeddingError("Encoding failed (%d texts): %s" % (len(prefixed), e)) from e
        return out

    def embed_passages(self, texts: Union[str, Sequence[str]], batch_size: int = 32):
        single = isinstance(texts, str)
        items = [texts] if single else list(texts)
        prefixed = ["passage: " + self._clean(t) for t in items]
        out = self._encode(prefixed, batch_size=batch_size)
        return out[0] if single else out

    def embed_query(self, texts: Union[str, Sequence[str]], batch_size: int = 32):
        single = isinstance(texts, str)
        items = [texts] if single else list(texts)
        prefixed = ["query: " + self._clean(t) for t in items]
        out = self._encode(prefixed, batch_size=batch_size)
        return out[0] if single else out


_provider = None
_provider_lock = threading.Lock()


def get_provider() -> EmbeddingProvider:
    global _provider
    if _provider is None:
        with _provider_lock:
            if _provider is None:
                _provider = EmbeddingProvider()
    return _provider


def to_pgvector(vec: Sequence[float]) -> str:
    return "[" + ",".join("%.7f" % float(x) for x in vec) + "]"


if __name__ == "__main__":
    import json
    print("model:", os.environ.get("EMBEDDING_MODEL", DEFAULT_MODEL))
    p = get_provider()
    print("loaded, dimension:", p.dimension, "device:", p.device)
    sentences = [
        "Այսօր եղանակը շատ լավն է։",
        "Դրսում արևոտ է։",
        "Նա գնաց մարզադաշտ։",
    ]
    vecs = p.embed_passages(sentences)
    print("passages:", len(vecs), "x", len(vecs[0]))

    def dot(a, b):
        return sum(x * y for x, y in zip(a, b))

    q = p.embed_query("Ինչպիսի՞ն է եղանակը այսօր։")
    sims = [round(dot(q, v), 4) for v in vecs]
    print("query~passage cosine:", json.dumps(sims))
    print("OK — closest:", sentences[sims.index(max(sims))])

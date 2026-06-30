"""
Build the HNSW vector index for Armenian embeddings on the production DB.
Single-process build (no parallel workers -> avoids shared-memory DiskFull).
Drops any leftover/invalid index first, then CREATE INDEX CONCURRENTLY with
statement_timeout disabled, holding the connection open until done (20-60 min,
single-process). CONCURRENTLY does not lock writes. Reads DATABASE_URL from ../.env.

Usage (PowerShell, from AilegalFinalVersion-main):
    pip install "psycopg[binary]"
    py scripts\build_hnsw_index.py
Leave the window open until it prints  index valid: True
"""
import os
import re
import time

def load_db_url():
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*DATABASE_URL\s*=\s*(.+)\s*$", line)
            if m:
                return m.group(1).strip().strip('"').strip()
    raise SystemExit("DATABASE_URL not found in .env")

CREATE_SQL = (
    "create index concurrently embeddings_hnsw_metric_idx "
    "on public.embeddings using hnsw (vector vector_cosine_ops) "
    "with (m=16, ef_construction=128) "
    "where (model='armenian-text-embeddings-2-large' and status='success')"
)

def main():
    try:
        import psycopg
    except ImportError:
        raise SystemExit('Install first:  pip install "psycopg[binary]"')
    dsn = load_db_url()
    print("Connecting...")
    with psycopg.connect(dsn, autocommit=True, connect_timeout=20) as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0")
            cur.execute("set lock_timeout = '15s'")
            cur.execute("set max_parallel_maintenance_workers = 0")
            cur.execute("set maintenance_work_mem = '512MB'")
            print("Dropping any leftover/invalid index...")
            cur.execute("drop index if exists public.embeddings_hnsw_metric_idx")
            print("Building HNSW index single-process (20-60 min, do NOT close this window)...")
            t0 = time.time()
            cur.execute(CREATE_SQL)
            print("DONE in", int(time.time() - t0), "s")
            cur.execute(
                "select indisvalid from pg_index x "
                "join pg_class i on i.oid = x.indexrelid "
                "where i.relname = 'embeddings_hnsw_metric_idx'"
            )
            row = cur.fetchone()
            print("index valid:", row[0] if row else "NOT FOUND")

if __name__ == "__main__":
    main()

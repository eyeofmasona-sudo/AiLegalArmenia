"""
Build an IVFFlat vector index for Armenian embeddings (fast, low-memory).
Much quicker to build than HNSW on small instances. Drops any leftover index
first. CONCURRENTLY = no write lock. Reads DATABASE_URL from ../.env.

Usage:
    pip install "psycopg[binary]"
    py scripts\build_ivfflat_index.py
"""
import os, re, time

def load_db_url():
    p = os.path.join(os.path.dirname(__file__), "..", ".env")
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*DATABASE_URL\s*=\s*(.+)\s*$", line)
            if m:
                return m.group(1).strip().strip('"').strip()
    raise SystemExit("DATABASE_URL not found in .env")

CREATE_SQL = (
    "create index concurrently embeddings_ivf_metric_idx "
    "on public.embeddings using ivfflat (vector vector_cosine_ops) "
    "with (lists = 900) "
    "where (model='armenian-text-embeddings-2-large' and status='success')"
)

def main():
    import psycopg
    dsn = load_db_url()
    print("Connecting...")
    with psycopg.connect(dsn, autocommit=True, connect_timeout=20) as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = 0")
            cur.execute("set lock_timeout = '15s'")
            cur.execute("set max_parallel_maintenance_workers = 0")
            cur.execute("set maintenance_work_mem = '512MB'")
            print("Dropping leftover HNSW build (if any)...")
            cur.execute("drop index if exists public.embeddings_hnsw_metric_idx")
            cur.execute("drop index if exists public.embeddings_ivf_metric_idx")
            print("Building IVFFlat index (do NOT close window)...")
            t0 = time.time()
            cur.execute(CREATE_SQL)
            print("DONE in", int(time.time() - t0), "s")
            cur.execute("select indisvalid from pg_index x join pg_class i on i.oid=x.indexrelid where i.relname='embeddings_ivf_metric_idx'")
            r = cur.fetchone()
            print("index valid:", r[0] if r else "NOT FOUND")

if __name__ == "__main__":
    main()

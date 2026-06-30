import os
import subprocess
from pathlib import Path

# Use the exact absolute path that worked in run_command
base_path = r"c:\Users\Admin\Desktop\Hayk\AILEGALARMENIA\Кодексы,законы\armenian_law\Арлис\ЕСПЧ"

env = os.environ.copy()
if not env.get('SUPABASE_SERVICE_ROLE_KEY'):
    raise SystemExit("SUPABASE_SERVICE_ROLE_KEY must be set")
if not env.get('SUPABASE_URL'):
    raise SystemExit("SUPABASE_URL must be set")

parts = [1, 2, 3, 4, 5]

for p in parts:
    infile = os.path.join(base_path, f"out_part{p}.jsonl")
    if os.path.exists(infile):
        print(f">>> STARTING PART {p}: {infile}")
        cmd = [
            "py", "scripts/translate_and_load_echr_to_supabase.py",
            infile,
            "--backend", "noop",
            "--skip-existing",
            "--upsert-batch-size", "50",
            "--import-ref", "echr-hy-bulk-v3"
        ]
        # Run and wait for each part
        subprocess.run(cmd, env=env)
    else:
        print(f"!!! SKIP: {infile} not found")

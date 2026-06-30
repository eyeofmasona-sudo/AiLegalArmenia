if (-not $env:SUPABASE_SERVICE_ROLE_KEY) {
    Write-Error "SUPABASE_SERVICE_ROLE_KEY must be set"
    exit 1
}
if (-not $env:SUPABASE_URL) {
    Write-Error "SUPABASE_URL must be set"
    exit 1
}

$parts = @(1, 2, 3, 4, 5)
# Find the directory by looking for out_part1.jsonl with wildcards
$p1 = Resolve-Path "../AILEGALARMENIA/*/armenian_law/*/out_part1.jsonl" -ErrorAction SilentlyContinue
if (-not $p1) {
    Write-Error "Could not find ECHR directory using wildcards!"
    exit 1
}

$basePath = Split-Path $p1[0].Path

Write-Host "Found ECHR path: $basePath"

foreach ($p in $parts) {
    $file = Join-Path $basePath "out_part$p.jsonl"
    if (Test-Path $file) {
        Write-Host ">>> STARTING PART ${p}"
        py scripts/translate_and_load_echr_to_supabase.py $file --ollama-model translategemma:4b --skip-existing --upsert-batch-size 10 --import-ref echr-hy-bulk-v3
    }
}

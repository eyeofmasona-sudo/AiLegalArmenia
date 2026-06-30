# Secret Hygiene & Rotation Checklist (H2)

**Status: OPERATOR ACTION REQUIRED.** Code/config hardening is done; the actual rotation must be
performed by the project owner. Do not skip — the live `.env` in the working tree contained real,
working secrets that were visible during audit.

## Why
`.env` (working tree) held **live** values for the keys below. It is gitignored, but it lives on disk
in the repo folder and its secrets were exposed to tooling/this session. Treat all of them as
potentially compromised and rotate.

## Where secrets must live (separation)
| Layer | What goes there | Notes |
|-------|-----------------|-------|
| Local dev `.env` | dev-only keys, never production service-role | gitignored; never paste into docs/commits |
| **Supabase Edge Function Secrets** | `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `EMBEDDING_ENDPOINT`, `EMBEDDING_API_KEY`, `QWEN_EMBEDDING_ENDPOINT` (if used), `INTERNAL_INGEST_KEY`, `CRON_WORKER_KEY`, `TELEGRAM_*` | `SUPABASE_URL`/`ANON`/`SERVICE_ROLE` are auto-injected — do NOT re-add |
| VPS server env (systemd) | `EMBEDDING_MODEL`, `EMBEDDING_API_KEY` | see `docs/VPS_EMBEDDINGS_DEPLOYMENT.md` |
| Vercel project env | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (anon only) | never put service-role/DB password in a `VITE_` var |
| CI/CD secrets store | `SUPABASE_ACCESS_TOKEN`, deploy tokens | not in repo |

## Rotation checklist (do each, then update the secret stores above)
- [ ] **Supabase service-role key + anon key** — Dashboard → Settings → API → "Reset"/rotate JWT secret if exposure is suspected. (Found: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.)
- [ ] **Supabase database password** — Dashboard → Settings → Database → reset password; update `DATABASE_URL` everywhere. (Found in `DATABASE_URL`.)
- [ ] **`SUPABASE_ACCESS_TOKEN`** (sbp_…) — revoke + reissue in Supabase account tokens.
- [ ] **OpenRouter key** (`sk-or-v1-…`) — revoke + reissue at openrouter.ai/keys.
- [ ] **Gemini API key** (`AIza…`) — revoke + reissue in Google AI Studio.
- [ ] **GitHub PAT(s)** (`ghp_…`) — revoke at github.com/settings/tokens. (Two present; likely unrelated to the app — remove from `.env`.)
- [ ] **Vercel token** (`vcp_…`) — revoke at vercel.com/account/tokens.
- [ ] **Telegram bot token / webhook secret** — if set in prod, rotate via BotFather and re-set webhook.
- [ ] **`INTERNAL_INGEST_KEY`, `CRON_WORKER_KEY`** — regenerate (random 32+ bytes), update edge secrets + any callers.
- [ ] **New `EMBEDDING_API_KEY`** — generate a fresh shared secret for the VPS embedding server (set on VPS + Edge Secrets).

## Verify no secret leaks remain in the repo
```bash
# 1. .env (and variants) must be ignored and NOT tracked:
git check-ignore .env .env.production .env.vps        # each should print the path
git ls-files | grep -E '^\.env($|\.)' | grep -v example   # must be EMPTY

# 2. No real secret material committed anywhere (placeholders only in tracked files):
git grep -nE 'sk-or-v1-|sbp_|ghp_|vcp_|AIza[0-9A-Za-z_-]{10,}|service_role' -- . ':!*.example' ':!docs/*' || echo "clean"

# 3. If a secret was EVER committed, rotating is mandatory; also scrub history:
#    git filter-repo --path .env --invert-paths   (or BFG), then force-push.
```

## Confirmed safe (no change needed)
- `.env.example` contains placeholders only.
- `docs/VPS_EMBEDDINGS_DEPLOYMENT.md` and this file use placeholders (`<secret>`, `<vps-domain>`).
- `.gitignore` now ignores `.env.*` while keeping `*.example`.

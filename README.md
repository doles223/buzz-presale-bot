# BUZZ.AI Presale Bot (Solana)

Backend that:
- Detects SOL deposits to your treasury wallet
- Auto-airdrops BUZZ to buyers (SPL token)
- Optional presale cap + live burn
- Tracks totals, recent buys, balances
- Shows LP reserved vs added, with proofs and a DEX chart hook
- Persists to Postgres (idempotent by tx signature)

## Endpoints
- `/health`   – service check
- `/config`   – tiers, deep links, LP plan, proofs
- `/stats`    – totals, cap remaining, burns, allocation (reserved/added)
- `/recent`   – recent purchases
- `/balances` – live treasury SOL, distributor SOL & BUZZ

## Deploy (Railway)
1. Create a new project, connect this GitHub repo.
2. Add a **Postgres** plugin; copy its connection URL.
3. Fill **Variables** (see .env.example). Required:
   - `TREASURY_ADDRESS` (your SOL receiver)
   - `BUZZ_MINT` (token mint)
   - `DISTRIBUTOR_PRIVATE_KEY` (JSON array)
   - `DATABASE_URL` (from Railway Postgres)
4. **Start Command**: `node server.js`
5. Open `/health`, `/config`, `/stats`.

## Wix
Use the provided HTML/JS embed, set `API_BASE` to your Railway URL, and publish.

// BUZZ.AI Presale backend (Solana, SPL)
// - Watches TREASURY_WALLET for incoming SOL
// - Auto-airdrops BUZZ from DISTRIBUTOR wallet (6 decimals)
// - Persists data in Postgres (Railway)
// - Serves /stats, /recent, /config, /health for the Wix page

import express from "express";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";
import pkg from "pg";

const { Pool } = pkg;

// ---------- CONFIG / ENV ----------
const DEFAULT_TREASURY = "A4ZUTuKrpXP1EmQENpGQAAap4R7K32DM8w36UeZRBMwn"; // your wallet
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const TREASURY_STR = process.env.TREASURY_WALLET || DEFAULT_TREASURY;
const COMMITMENT = process.env.NETWORK || "confirmed";
const BUZZ_PER_SOL = Number(process.env.BUZZ_PER_SOL || 70_000_000); // used if not an exact tier
const PORT = process.env.PORT || 3000;

const TIERS = [
  { sol: 0.10, buzz: 5_000_000 },
  { sol: 0.25, buzz: 15_000_000 },
  { sol: 0.50, buzz: 35_000_000 }
];

function need(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// Required env
let TREASURY_WALLET;
try { TREASURY_WALLET = new PublicKey(TREASURY_STR); }
catch { console.error("Invalid TREASURY_WALLET; using default."); TREASURY_WALLET = new PublicKey(DEFAULT_TREASURY); }

const BUZZ_MINT = (() => {
  const m = need("BUZZ_MINT");
  try { return new PublicKey(m); }
  catch { console.error("Invalid BUZZ_MINT"); process.exit(1); }
})();

const DISTRIBUTOR = (() => {
  const raw = need("DISTRIBUTOR_PRIVATE_KEY");
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 64) throw new Error("not a 64-byte array");
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch (e) {
    console.error("Bad DISTRIBUTOR_PRIVATE_KEY:", e.message);
    process.exit(1);
  }
})();

const conn = new Connection(RPC_URL, COMMITMENT);

// ---------- DATABASE (Postgres) ----------
const DATABASE_URL = need("DATABASE_URL");
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      tx_sig TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      sol NUMERIC NOT NULL,
      buzz BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
await initDb();

// Helpers for DB
async function hasProcessed(sig) {
  const r = await pool.query("SELECT 1 FROM purchases WHERE tx_sig = $1", [sig]);
  return r.rowCount > 0;
}

async function recordPurchase({ sig, sender, sol, buzz }) {
  await pool.query(
    "INSERT INTO purchases (tx_sig, sender, sol, buzz) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [sig, sender, sol, buzz]
  );
}

async function getTotals() {
  const r = await pool.query("SELECT COALESCE(SUM(sol), 0) AS total_sol, COALESCE(SUM(buzz),0) AS total_buzz FROM purchases");
  const row = r.rows[0] || { total_sol: 0, total_buzz: 0 };
  return { totalSol: Number(row.total_sol), totalBuzz: Number(row.total_buzz) };
}

async function getRecent(limit = 25) {
  const r = await pool.query(
    "SELECT sender, sol, buzz, tx_sig, created_at FROM purchases ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return r.rows.map(x => ({
    sender: x.sender,
    amountSol: Number(x.sol),
    buzz: Number(x.buzz),
    sig: x.tx_sig,
    when: x.created_at
  }));
}

// ---------- AIRDROP HELPERS ----------
function calcBuzzU64(amountSol) {
  const t = TIERS.find(t => Math.abs(t.sol - amountSol) < 1e-9);
  const buzzWhole = t ? t.buzz : Math.floor(amountSol * BUZZ_PER_SOL);
  return BigInt(buzzWhole) * 10n ** 6n; // convert to 6-dec units
}

async function airdropBuzz(toWallet, amountBuzzU64) {
  const buyer = new PublicKey(toWallet);
  const from = DISTRIBUTOR.publicKey;

  const fromAta = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, from);
  const toAta   = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, buyer);

  await transfer(conn, DISTRIBUTOR, fromAta.address, toAta.address, DISTRIBUTOR.publicKey, amountBuzzU64);
}

// ---------- POLLER (checks for new deposits) ----------
async function processSig(sigInfo) {
  // Skip signatures we’ve already processed (DB check)
  const processed = await hasProcessed(sigInfo.signature);
  if (processed) return;

  const tx = await conn.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return;

  const ins = tx.transaction.message.instructions || [];
  for (const i of ins) {
    if (i.program !== "system" || i.parsed?.type !== "transfer") continue;
    const info = i.parsed?.info || {};
    if (info.destination !== TREASURY_WALLET.toBase58()) continue;

    const lamports = BigInt(info.lamports || 0);
    if (lamports <= 0n) continue;

    const amountSol = Number(lamports) / 1_000_000_000;
    const sender = info.source;

    const buzzU64 = calcBuzzU64(amountSol);
    if (buzzU64 <= 0n) continue;

    // Airdrop BUZZ first (if this throws, we DO NOT record the purchase)
    await airdropBuzz(sender, buzzU64);

    const buzzWhole = Number(buzzU64 / (10n ** 6n));
    await recordPurchase({ sig: sigInfo.signature, sender, sol: amountSol, buzz: buzzWhole });

    console.log(`✔ Airdropped ${buzzWhole} BUZZ to ${sender} for ${amountSol} SOL (${sigInfo.signature})`);
  }
}

async function warmStart() {
  // Mark existing last N as processed by writing them with zero effect (optional),
  // or simply rely on hasProcessed() to skip. Here we just mark in-memory nothing,
  // because DB idempotency by tx_sig is enough.
  console.log("Warm start ready.");
}

async function poll() {
  try {
    // Grab recent signatures involving the TREASURY wallet
    const sigs = await conn.getSignaturesForAddress(TREASURY_WALLET, { limit: 30 });
    // Process oldest -> newest for order
    for (const s of sigs.reverse()) {
      await processSig(s);
    }
  } catch (e) {
    console.error("poll error:", e?.message || e);
  }
}

// ---------- API ----------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("BUZZ Presale Bot OK"));

app.get("/config", (_req, res) => {
  const recipient = TREASURY_WALLET.toBase58();
  const label = encodeURIComponent("BUZZ.AI Presale");
  const msg = encodeURIComponent("Thanks for supporting BUZZ.AI");
  const memo = encodeURIComponent("BUZZPRESALE");
  const solLink = (amt) => `solana:${recipient}?amount=${amt}&label=${label}&message=${msg}&memo=${memo}`;
  const phantom = (amt) => `https://phantom.app/ul/browse/solana/transfer?recipient=${recipient}&amount=${amt}&network=mainnet&reference=BUZZPRESALE&label=${label}`;

  res.json({
    recipient,
    tiers: TIERS,
    links: {
      "0.10": { solanaUri: solLink(0.10), phantom: phantom(0.10) },
      "0.25": { solanaUri: solLink(0.25), phantom: phantom(0.25) },
      "0.50": { solanaUri: solLink(0.50), phantom: phantom(0.50) }
    }
  });
});

app.get("/stats", async (_req, res) => {
  try {
    const t = await getTotals();
    res.json({
      treasury: TREASURY_WALLET.toBase58(),
      tiers: TIERS,
      totalSolRaised: Number(t.totalSol.toFixed(6)),
      totalBuzzSold: t.totalBuzz
    });
  } catch (e) {
    res.status(500).json({ error: "stats failed" });
  }
});

app.get("/recent", async (_req, res) => {
  try {
    const r = await getRecent(25);
    res.json(r);
  } catch {
    res.json([]);
  }
});

app.get("/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, time: new Date().toISOString() }); }
  catch { res.status(500).json({ ok: false }); }
});

// ---------- BOOT ----------
app.listen(PORT, async () => {
  console.log(`Bot listening on ${PORT}`);
  await warmStart();
  // Start poller
  setInterval(poll, 30_000);
});


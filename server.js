// BUZZ.AI Presale Bot (Solana)
// - Watches TREASURY address for incoming SOL
// - Auto-airdrops BUZZ from DISTRIBUTOR wallet
// - Persists purchases in Postgres if DATABASE_URL is set
// - Serves /health /config /stats /recent for the Wix page

import express from "express";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";
import pkg from "pg";

const { Pool } = pkg;

// ---------- ENV ----------
const ENV = (k, d = undefined) => (process.env[k] ?? d);

const RPC_URL          = ENV("RPC_URL", "https://api.mainnet-beta.solana.com");
const CLUSTER          = ENV("CLUSTER", "mainnet-beta");
const NETWORK          = ENV("NETWORK", "confirmed"); // commitment

// Treasury (where buyers send SOL)
const TREASURY_STR     = ENV("TREASURY_ADDRESS", ENV("TREASURY_WALLET", "")); // you set this
if (!TREASURY_STR) throw new Error("Missing TREASURY_ADDRESS / TREASURY_WALLET");
let TREASURY;
try { TREASURY = new PublicKey(TREASURY_STR); }
catch { throw new Error("TREASURY address invalid"); }

// Token config
const BUZZ_MINT_STR    = ENV("BUZZ_MINT", "");
if (!BUZZ_MINT_STR) throw new Error("Missing BUZZ_MINT");
let BUZZ_MINT;
try { BUZZ_MINT = new PublicKey(BUZZ_MINT_STR); }
catch { throw new Error("BUZZ_MINT invalid"); }

const TOKEN_DECIMALS   = Number(ENV("TOKEN_DECIMALS", "6"));
const BUZZ_PER_SOL     = Number(ENV("BUZZ_PER_SOL", "70000000")); // fallback if not exact tier

// Distributor signer (airdrops BUZZ)
const DISTRIBUTOR_JSON = ENV("DISTRIBUTOR_PRIVATE_KEY", "");
if (!DISTRIBUTOR_JSON) throw new Error("Missing DISTRIBUTOR_PRIVATE_KEY (JSON array)");
let DISTRIBUTOR;
try {
  const arr = JSON.parse(DISTRIBUTOR_JSON);
  DISTRIBUTOR = Keypair.fromSecretKey(Uint8Array.from(arr));
} catch (e) {
  throw new Error("DISTRIBUTOR_PRIVATE_KEY must be a JSON array like [12,34,...]");
}
const DISTRIBUTOR_PUB = DISTRIBUTOR.publicKey;

// Tiers (defaults for your UX)
const TIER_1_PRICE    = Number(ENV("TIER_1_PRICE", "0.10"));
const TIER_1_ALLOC    = Number(ENV("TIER_1_ALLOCATION", "5000000"));
const TIER_2_PRICE    = Number(ENV("TIER_2_PRICE", "0.25"));
const TIER_2_ALLOC    = Number(ENV("TIER_2_ALLOCATION", "15000000"));
const TIER_3_PRICE    = Number(ENV("TIER_3_PRICE", "0.50"));
const TIER_3_ALLOC    = Number(ENV("TIER_3_ALLOCATION", "35000000"));
// optional extra tier
const TIER_4_PRICE    = Number(ENV("TIER_4_PRICE", "0"));
const TIER_4_ALLOC    = Number(ENV("TIER_4_ALLOCATION", "0"));

const TIERS = [
  ...(TIER_1_PRICE ? [{ sol: TIER_1_PRICE, buzz: TIER_1_ALLOC }] : []),
  ...(TIER_2_PRICE ? [{ sol: TIER_2_PRICE, buzz: TIER_2_ALLOC }] : []),
  ...(TIER_3_PRICE ? [{ sol: TIER_3_PRICE, buzz: TIER_3_ALLOC }] : []),
  ...(TIER_4_PRICE ? [{ sol: TIER_4_PRICE, buzz: TIER_4_ALLOC }] : []),
];

const SOL_GOAL        = Number(ENV("SOL_GOAL", "3800"));
const PORT            = Number(ENV("PORT", "3000"));
const DATABASE_URL    = ENV("DATABASE_URL"); // optional but recommended

// ---------- SOLANA ----------
const conn = new Connection(RPC_URL, NETWORK);

// ---------- DB (Postgres optional) ----------
let pool = null;
let memoryProcessed = new Set(); // fallback if no DB
let memoryRows = [];             // recent rows fallback

async function initDb() {
  if (!DATABASE_URL) {
    console.log("No DATABASE_URL set → running in memory (non-persistent).");
    return;
  }
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
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

async function hasProcessed(sig) {
  if (!pool) return memoryProcessed.has(sig);
  const r = await pool.query("SELECT 1 FROM purchases WHERE tx_sig = $1", [sig]);
  return r.rowCount > 0;
}

async function recordPurchase(row) {
  if (!pool) {
    memoryProcessed.add(row.sig);
    memoryRows.unshift({
      sender: row.sender, amountSol: row.sol, buzz: row.buzz, sig: row.sig, when: new Date()
    });
    memoryRows = memoryRows.slice(0, 50);
    return;
  }
  await pool.query(
    "INSERT INTO purchases (tx_sig, sender, sol, buzz) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [row.sig, row.sender, row.sol, row.buzz]
  );
}

async function getTotals() {
  if (!pool) {
    const totalSol = memoryRows.reduce((s, r) => s + Number(r.amountSol), 0);
    const totalBuzz = memoryRows.reduce((s, r) => s + Number(r.buzz), 0);
    return { totalSol, totalBuzz };
  }
  const r = await pool.query("SELECT COALESCE(SUM(sol),0) AS total_sol, COALESCE(SUM(buzz),0) AS total_buzz FROM purchases");
  return { totalSol: Number(r.rows[0].total_sol), totalBuzz: Number(r.rows[0].total_buzz) };
}

async function getRecent(limit = 25) {
  if (!pool) return memoryRows.slice(0, limit);
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

// ---------- AIRDROP ----------
function toU64(whole, decimals) {
  return BigInt(Math.floor(whole)) * 10n ** BigInt(decimals);
}

function calcBuzzWhole(amountSol) {
  const t = TIERS.find(t => Math.abs(t.sol - amountSol) < 1e-9);
  return t ? t.buzz : Math.floor(amountSol * BUZZ_PER_SOL);
}

async function airdropBuzz(toWallet, buzzWhole) {
  const buyer = new PublicKey(toWallet);
  const from = DISTRIBUTOR_PUB;

  const fromAta = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, from);
  const toAta   = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, buyer);

  const amountU64 = BigInt(buzzWhole) * 10n ** BigInt(TOKEN_DECIMALS);
  await transfer(conn, DISTRIBUTOR, fromAta.address, toAta.address, DISTRIBUTOR_PUB, amountU64);
}

// ---------- POLLER ----------
async function processSignature(sigInfo) {
  const sig = sigInfo.signature;
  if (await hasProcessed(sig)) return;

  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return;

  const ins = tx.transaction.message.instructions || [];
  for (const i of ins) {
    if (i.program !== "system" || i.parsed?.type !== "transfer") continue;
    const info = i.parsed?.info || {};
    if (info.destination !== TREASURY.toBase58()) continue;

    const lamports = BigInt(info.lamports || 0);
    if (lamports <= 0n) continue;

    const amountSol = Number(lamports) / 1_000_000_000;
    const sender = info.source;

    // Optional guardrails (edit to taste)
    if (amountSol < 0.05) continue; // ignore dust
    if (amountSol > 500) continue;  // ignore whales by mistake

    const buzzWhole = calcBuzzWhole(amountSol);
    if (!buzzWhole || buzzWhole <= 0) continue;

    // Airdrop first (if this fails we do NOT record)
    await airdropBuzz(sender, buzzWhole);

    await recordPurchase({ sig, sender, sol: amountSol, buzz: buzzWhole });
    console.log(`✔ Airdropped ${buzzWhole} BUZZ to ${sender} for ${amountSol} SOL (${sig})`);
  }
}

async function poll() {
  try {
    const sigs = await conn.getSignaturesForAddress(TREASURY, { limit: 30 });
    for (const s of sigs.reverse()) {
      await processSignature(s);
    }
  } catch (e) {
    console.error("poll error:", e?.message || e);
  }
}

// ---------- API ----------
const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    if (pool) await pool.query("SELECT 1");
    res.json({ ok: true, cluster: CLUSTER, commitment: NETWORK, treasury: TREASURY.toBase58() });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get("/config", (_req, res) => {
  const recipient = TREASURY.toBase58();
  const label = encodeURIComponent("BUZZ.AI Presale");
  const message = encodeURIComponent("Thanks for supporting BUZZ.AI");
  const memo = encodeURIComponent("BUZZPRESALE");
  const solLink = (amt) => `solana:${recipient}?amount=${amt}&label=${label}&message=${message}&memo=${memo}`;
  const phantom = (amt) => `https://phantom.app/ul/browse/solana/transfer?recipient=${recipient}&amount=${amt}&network=mainnet&reference=BUZZPRESALE&label=${label}`;

  res.json({
    recipient,
    mint: BUZZ_MINT.toBase58(),
    decimals: TOKEN_DECIMALS,
    tiers: TIERS,
    links: Object.fromEntries(TIERS.map(t => [String(t.sol), { solanaUri: solLink(t.sol), phantom: phantom(t.sol) }]))
  });
});

app.get("/stats", async (_req, res) => {
  try {
    const t = await getTotals();
    res.json({
      totalSolRaised: Number(t.totalSol.toFixed(6)),
      totalBuzzSold: t.totalBuzz,
      goal: SOL_GOAL,
      treasury: TREASURY.toBase58()
    });
  } catch {
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

app.get("/", (_req, res) => res.send("BUZZ Presale Bot is live."));

// ---------- BOOT ----------
await initDb();

app.listen(PORT, async () => {
  console.log(`BUZZ bot listening on ${PORT} (cluster: ${CLUSTER}, commitment: ${NETWORK})`);
  console.log(`Treasury: ${TREASURY.toBase58()} | Distributor: ${DISTRIBUTOR_PUB.toBase58()} | Mint: ${BUZZ_MINT.toBase58()}`);
  // start poller
  setInterval(poll, 30_000);
});
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


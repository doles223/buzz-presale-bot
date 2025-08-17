// BUZZ.AI Presale Bot (Solana) — full, production-ready
// - Watches TREASURY for incoming SO
// - Auto-airdrops BUZZ from DISTRIBUTOR wallet
// - Optional presale cap + live presale burn (extra/take)
// - Transparency endpoints: stats, balances, lp plan, proofs
// - Postgres persistence (idempotent by tx signature)
// - Works on Railway out of the box

import express from "express";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transfer, burn } from "@solana/spl-token";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// ---------- ENV ----------
const ENV = (k, d) => (process.env[k] ?? d);

const PORT            = Number(ENV("PORT", "3000"));
const RPC_URL         = ENV("RPC_URL", "https://api.mainnet-beta.solana.com");
const NETWORK         = ENV("NETWORK", "confirmed");
const CLUSTER         = ENV("CLUSTER", "mainnet-beta");

const TREASURY_STR    = ENV("TREASURY_ADDRESS", ENV("TREASURY_WALLET", ""));
if (!TREASURY_STR) throw new Error("Missing TREASURY_ADDRESS");
let TREASURY;
try { TREASURY = new PublicKey(TREASURY_STR); } catch { throw new Error("TREASURY_ADDRESS invalid"); }

const BUZZ_MINT_STR   = ENV("BUZZ_MINT", "");
if (!BUZZ_MINT_STR) throw new Error("Missing BUZZ_MINT");
let BUZZ_MINT;
try { BUZZ_MINT = new PublicKey(BUZZ_MINT_STR); } catch { throw new Error("BUZZ_MINT invalid"); }

const TOKEN_DECIMALS  = Number(ENV("TOKEN_DECIMALS", "6"));
const BUZZ_PER_SOL    = Number(ENV("BUZZ_PER_SOL", "70000000")); // fallback if no tier match

// tiers (editable via env; if omitted, we'll build from BUZZ_PER_SOL when rendering)
const TIER_1_PRICE    = Number(ENV("TIER_1_PRICE", "0.10"));
const TIER_1_ALLOC    = Number(ENV("TIER_1_ALLOCATION", "5000000"));
const TIER_2_PRICE    = Number(ENV("TIER_2_PRICE", "0.25"));
const TIER_2_ALLOC    = Number(ENV("TIER_2_ALLOCATION", "15000000"));
const TIER_3_PRICE    = Number(ENV("TIER_3_PRICE", "0.50"));
const TIER_3_ALLOC    = Number(ENV("TIER_3_ALLOCATION", "35000000"));
const TIER_4_PRICE    = Number(ENV("TIER_4_PRICE", "0"));
const TIER_4_ALLOC    = Number(ENV("TIER_4_ALLOCATION", "0"));

const TIERS = [
  ...(TIER_1_PRICE ? [{ sol: TIER_1_PRICE, buzz: TIER_1_ALLOC }] : []),
  ...(TIER_2_PRICE ? [{ sol: TIER_2_PRICE, buzz: TIER_2_ALLOC }] : []),
  ...(TIER_3_PRICE ? [{ sol: TIER_3_PRICE, buzz: TIER_3_ALLOC }] : []),
  ...(TIER_4_PRICE ? [{ sol: TIER_4_PRICE, buzz: TIER_4_ALLOC }] : []),
];

const SOL_GOAL        = Number(ENV("SOL_GOAL", "3800"));
const DATABASE_URL    = ENV("DATABASE_URL", "");

// Optional guards
const MIN_SOL         = Number(ENV("MIN_SOL", "0.05"));
const MAX_SOL         = Number(ENV("MAX_SOL", "500"));

// Presale cap (total BUZZ that can be distributed to buyers)
const PRESALE_CAP     = Number(ENV("PRESALE_CAP_BUZZ", "0")); // 0 = off

// Presale burn during sales
const BURN_MODE       = ENV("BURN_MODE", "off"); // "off" | "extra" | "take"
const BURN_RATE_BPS   = Number(ENV("BURN_RATE_BPS", "0")); // 500 = 5%

// Liquidity accounting (reserved vs added; listing rate)
const LP_SPLIT_BPS        = Number(ENV("LP_SPLIT_BPS", "7900"));  // 79% to LP
const TREASURY_SPLIT_BPS  = Number(ENV("TREASURY_SPLIT_BPS", "2100"));
const LP_RATE_BUZZ_PER_SOL= Number(ENV("LP_RATE_BUZZ_PER_SOL", "21930")); // Buzz paired per 1 SOL in LP at listing rate

const LP_TARGET_SOL   = Number(ENV("LP_TARGET_SOL", "3000"));
const LP_ADDED_SOL    = Number(ENV("LP_ADDED_SOL", "0"));
const LP_ADDED_BUZZ   = Number(ENV("LP_ADDED_BUZZ", "0"));
const LP_PAIR_ADDRESS = ENV("LP_PAIR_ADDRESS", "");
const LP_ADD_TX_SIGS  = (ENV("LP_ADD_TX_SIGS","").trim() ? ENV("LP_ADD_TX_SIGS").split(",").map(s=>s.trim()) : []);
const LP_LOCK_TX_SIGS = (ENV("LP_LOCK_TX_SIGS","").trim() ? ENV("LP_LOCK_TX_SIGS").split(",").map(s=>s.trim()) : []);

// Distributor signer (airdrop + burn authority)
const DIST_JSON = ENV("DISTRIBUTOR_PRIVATE_KEY", "");
if (!DIST_JSON) throw new Error("Missing DISTRIBUTOR_PRIVATE_KEY (JSON array)");
let DISTRIBUTOR;
try {
  const arr = JSON.parse(DIST_JSON);
  DISTRIBUTOR = Keypair.fromSecretKey(Uint8Array.from(arr));
} catch (e) {
  throw new Error("DISTRIBUTOR_PRIVATE_KEY must be JSON array like [12,34,...]");
}
const DISTRIBUTOR_PUB = DISTRIBUTOR.publicKey;

// ---------- SOLANA ----------
const conn = new Connection(RPC_URL, NETWORK);

// ---------- DB (optional Postgres) ----------
let pool = null;
let memProcessed = new Set();
let memRows = []; // fallback in-memory log

async function initDb() {
  if (!DATABASE_URL) {
    console.log("No DATABASE_URL set → running in-memory (non-persistent).");
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS burns (
      id BIGSERIAL PRIMARY KEY,
      amount_buzz BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function hasProcessed(sig) {
  if (!pool) return memProcessed.has(sig);
  const r = await pool.query("SELECT 1 FROM purchases WHERE tx_sig=$1", [sig]);
  return r.rowCount > 0;
}

async function recordPurchase({ sig, sender, sol, buzz }) {
  if (!pool) {
    memProcessed.add(sig);
    memRows.unshift({ sender, amountSol: sol, buzz, sig, when: new Date() });
    memRows = memRows.slice(0, 50);
    return;
  }
  await pool.query(
    "INSERT INTO purchases (tx_sig, sender, sol, buzz) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [sig, sender, sol, buzz]
  );
}

async function getTotals() {
  if (!pool) {
    const totalSol = memRows.reduce((s, r) => s + Number(r.amountSol), 0);
    const totalBuzz= memRows.reduce((s, r) => s + Number(r.buzz), 0);
    return { totalSol, totalBuzz };
  }
  const r = await pool.query("SELECT COALESCE(SUM(sol),0) AS s, COALESCE(SUM(buzz),0) AS b FROM purchases");
  return { totalSol: Number(r.rows[0].s), totalBuzz: Number(r.rows[0].b) };
}

async function getRecent(limit=25) {
  if (!pool) return memRows.slice(0, limit);
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

async function recordBurn(amountBuzzWhole) {
  if (!amountBuzzWhole || amountBuzzWhole <= 0) return;
  if (!pool) return;
  await pool.query("INSERT INTO burns (amount_buzz) VALUES ($1)", [amountBuzzWhole]);
}

async function getTotalBurned() {
  if (!pool) return 0;
  const r = await pool.query("SELECT COALESCE(SUM(amount_buzz),0) AS burned FROM burns");
  return Number(r.rows[0].burned);
}

// ---------- BUZZ helpers ----------
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

async function burnBuzz(amountWhole) {
  if (!amountWhole || amountWhole <= 0) return;
  const from = DISTRIBUTOR_PUB;
  const fromAta = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, from);
  const amtU64 = BigInt(amountWhole) * 10n ** BigInt(TOKEN_DECIMALS);
  await burn(conn, DISTRIBUTOR, fromAta.address, BUZZ_MINT, DISTRIBUTOR_PUB, amtU64);
  await recordBurn(amountWhole);
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

    if (amountSol < MIN_SOL || amountSol > MAX_SOL) continue;

    // Calculate owed BUZZ
    let buzzWhole = calcBuzzWhole(amountSol);
    if (!buzzWhole || buzzWhole <= 0) continue;

    // Enforce presale cap (only count tokens sent to buyers)
    if (PRESALE_CAP > 0) {
      const t = await getTotals();
      const remaining = Math.max(0, PRESALE_CAP - t.totalBuzz);
      if (remaining <= 0) return; // cap reached
      if (buzzWhole > remaining) buzzWhole = remaining; // pro-rate final buyer
    }

    // Burn logic
    let buyerBuzz = buzzWhole;
    let burnWhole = 0;

    if (BURN_MODE === "take" && BURN_RATE_BPS > 0) {
      burnWhole = Math.floor(buzzWhole * BURN_RATE_BPS / 10_000);
      buyerBuzz = buzzWhole - burnWhole;
      if (buyerBuzz <= 0) return;
    }

    // 1) send tokens to buyer
    await airdropBuzz(sender, buyerBuzz);

    // 2) extra burn (or take burn already calculated)
    if (BURN_MODE === "extra" && BURN_RATE_BPS > 0) {
      burnWhole = Math.floor(buyerBuzz * BURN_RATE_BPS / 10_000);
    }
    if (burnWhole > 0) await burnBuzz(burnWhole);

    // 3) record purchase (only buyerBuzz counts toward cap/stat)
    await recordPurchase({ sig, sender, sol: amountSol, buzz: buyerBuzz });

    console.log(`✔ Airdropped ${buyerBuzz} BUZZ ${burnWhole?`(+ burned ${burnWhole}) `:""}to ${sender} for ${amountSol} SOL (${sig})`);
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
app.get("/", (_req, res) => res.send("BUZZ Presale Bot is live."));

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

  // if TIERS are empty, synthesize from BUZZ_PER_SOL for 0.10 / 0.25 / 0.50
  const tiers = (TIERS.length ? TIERS : [
    { sol: 0.10, buzz: Math.floor(BUZZ_PER_SOL * 0.10) },
    { sol: 0.25, buzz: Math.floor(BUZZ_PER_SOL * 0.25) },
    { sol: 0.50, buzz: Math.floor(BUZZ_PER_SOL * 0.50) },
  ]);

  res.json({
    recipient,
    mint: BUZZ_MINT.toBase58(),
    decimals: TOKEN_DECIMALS,
    tiers,
    links: Object.fromEntries(tiers.map(t => [String(t.sol), { solanaUri: solLink(t.sol), phantom: phantom(t.sol) }])),
    lp: {
      targetSol: LP_TARGET_SOL,
      addedSol: LP_ADDED_SOL,
      addedBuzz: LP_ADDED_BUZZ,
      pairAddress: LP_PAIR_ADDRESS || null
    },
    proofs: {
      lpAddTxs: LP_ADD_TX_SIGS,
      lpLockOrBurnTxs: LP_LOCK_TX_SIGS,
      treasury: recipient
    }
  });
});

app.get("/balances", async (_req, res) => {
  try {
    const [treaLam, distLam] = await Promise.all([
      conn.getBalance(TREASURY),
      conn.getBalance(DISTRIBUTOR_PUB),
    ]);
    const treasurySol     = treaLam / 1_000_000_000;
    const distributorSol  = distLam / 1_000_000_000;

    // distributor BUZZ ATA balance
    const fromAta = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, DISTRIBUTOR_PUB);
    const bal = await conn.getTokenAccountBalance(fromAta.address);
    const distributorBuzz = Number(bal.value.uiAmount || 0);

    res.json({ treasurySol, distributorSol, distributorBuzz });
  } catch (e) {
    res.status(500).json({ error: "balances failed" });
  }
});

app.get("/recent", async (_req, res) => {
  try { res.json(await getRecent(25)); }
  catch { res.json([]); }
});

app.get("/stats", async (_req, res) => {
  try {
    const t = await getTotals();
    const burned = await getTotalBurned();

    // Live reserved/added math for LP/Treasury
    const lpReservedSol = Number((t.totalSol * (LP_SPLIT_BPS / 10000)).toFixed(6));
    const treasuryReservedSol = Number((t.totalSol * (TREASURY_SPLIT_BPS / 10000)).toFixed(6));

    const lpBuzzNeededAtListing = Math.floor(lpReservedSol * LP_RATE_BUZZ_PER_SOL);
    const lpRemainingToAddSol = Math.max(0, lpReservedSol - LP_ADDED_SOL);
    const lpRemainingToAddBuzz = Math.max(0, lpBuzzNeededAtListing - LP_ADDED_BUZZ);

    const remainingCap = PRESALE_CAP > 0 ? Math.max(0, PRESALE_CAP - t.totalBuzz) : null;

    res.json({
      totalSolRaised: Number(t.totalSol.toFixed(6)),
      totalBuzzSold: t.totalBuzz,          // to buyers
      totalBuzzBurned: burned,             // burned during presale
      presaleCap: PRESALE_CAP || null,
      presaleRemaining: remainingCap,
      goal: SOL_GOAL,
      treasury: TREASURY.toBase58(),
      burnMode: BURN_MODE,
      burnRateBps: BURN_RATE_BPS,
      allocation: {
        lpSplitBps: LP_SPLIT_BPS,
        treasurySplitBps: TREASURY_SPLIT_BPS,
        reserved: {
          lpSol: lpReservedSol,
          treasurySol: treasuryReservedSol,
          lpBuzzAtListing: lpBuzzNeededAtListing
        },
        added: {
          lpSol: LP_ADDED_SOL,
          lpBuzz: LP_ADDED_BUZZ
        },
        remainingToAdd: {
          lpSol: lpRemainingToAddSol,
          lpBuzz: lpRemainingToAddBuzz
        }
      },
      lp: {
        targetSol: LP_TARGET_SOL,
        addedSol: LP_ADDED_SOL,
        addedBuzz: LP_ADDED_BUZZ,
        pairAddress: LP_PAIR_ADDRESS || null
      },
      proofs: {
        lpAddTxs: LP_ADD_TX_SIGS,
        lpLockOrBurnTxs: LP_LOCK_TX_SIGS
      }
    });
  } catch (e) {
    res.status(500).json({ error: "stats failed" });
  }
});

// ---------- BOOT ----------
await initDb();
app.listen(PORT, async () => {
  console.log(`BUZZ bot listening on ${PORT} (cluster: ${CLUSTER}, commitment: ${NETWORK})`);
  console.log(`Treasury: ${TREASURY.toBase58()} | Distributor: ${DISTRIBUTOR_PUB.toBase58()} | Mint: ${BUZZ_MINT.toBase58()}`);
  setInterval(poll, 30_000);
});

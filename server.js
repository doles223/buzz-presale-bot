// server.js
// BUZZ.AI wallet-to-wallet presale bot (Solana, SPL)
// - Watches your TREASURY_WALLET for incoming SOL
// - Auto-sends BUZZ tokens from DISTRIBUTOR wallet based on tiers / base rate
// - Exposes /stats for your Wix progress bar

import express from "express";
import {
  Connection,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";

// -------------------- ENV --------------------
// Set these in Railway → Service → Variables
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const TREASURY_WALLET = new PublicKey(process.env.TREASURY_WALLET); // SOL receive wallet (Phantom)
const DISTRIBUTOR_PRIVATE_KEY = JSON.parse(process.env.DISTRIBUTOR_PRIVATE_KEY); // JSON array of 64 bytes
const DISTRIBUTOR = Keypair.fromSecretKey(Uint8Array.from(DISTRIBUTOR_PRIVATE_KEY)); // signer that holds BUZZ
const BUZZ_MINT = new PublicKey(process.env.BUZZ_MINT); // BUZZ mint (DECIMALS = 6)
const COMMITMENT = process.env.NETWORK || "confirmed";   // or "finalized"
const BUZZ_PER_SOL = Number(process.env.BUZZ_PER_SOL || 70_000_000); // fallback for non-exact amounts

// Exact-price tiers (SOL → whole BUZZ tokens). Edit if you change pricing.
const TIERS = [
  { sol: 0.10, buzz: 5_000_000 },
  { sol: 0.25, buzz: 15_000_000 },
  { sol: 0.50, buzz: 35_000_000 },
];

// -------------------- APP SETUP --------------------
const app = express();
app.use(express.json());

const conn = new Connection(RPC_URL, COMMITMENT);

// Simple in-memory state (good enough for MVP; you can swap for Postgres later)
const processed = new Set();      // tx signatures already fulfilled
let totals = { sol: 0, buzz: 0 }; // running totals
const recent = [];                // last N payouts
const MAX_RECENT = 25;

// -------------------- HELPERS --------------------
function calcBuzzU64(amountSol) {
  // If amount matches a tier exactly, use that tier; otherwise pro-rate by BUZZ_PER_SOL
  const tier = TIERS.find(t => Math.abs(t.sol - amountSol) < 1e-9);
  const buzzWhole = tier ? tier.buzz : Math.floor(amountSol * BUZZ_PER_SOL);
  // Convert to base units (6 decimals)
  return BigInt(buzzWhole) * 10n ** 6n;
}

async function airdropBuzz(toWallet, amountBuzzU64) {
  const buyer = new PublicKey(toWallet);
  const from = DISTRIBUTOR.publicKey;

  // Ensure both sides have ATAs; creates if missing (payer = DISTRIBUTOR)
  const fromAta = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, from);
  const toAta   = await getOrCreateAssociatedTokenAccount(conn, DISTRIBUTOR, BUZZ_MINT, buyer);

  // Transfer BUZZ (amount in base units as bigint)
  await transfer(conn, DISTRIBUTOR, fromAta.address, toAta.address, DISTRIBUTOR.publicKey, amountBuzzU64);
}

async function markExistingAsProcessedOnBoot() {
  // Prevent back-paying historical deposits when the bot first starts
  try {
    const sigs = await conn.getSignaturesForAddress(TREASURY_WALLET, { limit: 50 });
    sigs.forEach(s => processed.add(s.signature));
    console.log(`Warm start: marked ${sigs.length} existing deposits as processed.`);
  } catch (e) {
    console.error("Warm start error:", e?.message || e);
  }
}

// -------------------- POLLING LOOP --------------------
async function poll() {
  try {
    // Grab recent signatures to TREASURY
    const sigs = await conn.getSignaturesForAddress(TREASURY_WALLET, { limit: 30 });

    // Process oldest → newest to keep order
    for (const s of sigs.reverse()) {
      if (processed.has(s.signature)) continue;

      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) { processed.add(s.signature); continue; }

      const ins = tx.transaction.message.instructions || [];
      for (const i of ins) {
        // We only care about native SOL transfers to the treasury
        if (i.program !== "system" || i.parsed?.type !== "transfer") continue;

        const info = i.parsed?.info || {};
        if (info.destination !== TREASURY_WALLET.toBase58()) continue;

        const lamports = BigInt(info.lamports || 0);
        if (lamports <= 0n) continue;

        const amountSol = Number(lamports) / 1_000_000_000;
        const sender = info.source;
        const buzzU64 = calcBuzzU64(amountSol);
        if (buzzU64 <= 0n) continue;

        // Send BUZZ to the sender
        await airdropBuzz(sender, buzzU64);

        // Bookkeeping
        processed.add(s.signature);
        totals.sol += amountSol;
        const buzzWhole = Number(buzzU64 / (10n ** 6n));
        totals.buzz += buzzWhole;

        recent.unshift({
          when: new Date().toISOString(),
          sender,
          amountSol: Number(amountSol.toFixed(6)),
          buzz: buzzWhole,
          sig: s.signature
        });
        if (recent.length > MAX_RECENT) recent.pop();

        console.log(`Paid ${buzzWhole} BUZZ to ${sender} for ${amountSol} SOL (tx ${s.signature})`);
      }
    }
  } catch (e) {
    console.error("poll error:", e?.message || e);
  }
}

// Run the poller every 30 seconds
setInterval(poll, 30_000);

// -------------------- API (for Wix) --------------------
app.get("/", (_req, res) => res.send("BUZZ Presale Bot OK"));
app.get("/stats", (_req, res) => {
  res.json({
    treasury: TREASURY_WALLET.toBase58(),
    tiers: TIERS,
    totalSolRaised: Number(totals.sol.toFixed(6)),
    totalBuzzSold: totals.buzz
  });
});
app.get("/recent", (_req, res) => res.json(recent));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// -------------------- BOOT --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Bot listening on ${PORT}`);
  await markExistingAsProcessedOnBoot();  // avoid back-paying old txs
});

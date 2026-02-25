#!/usr/bin/env node
/**
 * Prints the admin wallet addresses (public keys) derived from the seed secrets in .env.
 * Expects AUTHORITY_SEED_1 and AUTHORITY_SEED_2 (64 hex chars each) in env.
 *
 * Run: node scripts/print-admin-wallets.js
 * Or:  source .env 2>/dev/null; node scripts/print-admin-wallets.js
 * (Or use dotenv: node -r dotenv/config scripts/print-admin-wallets.js)
 */
require("dotenv").config();
const { Keypair } = require("@solana/web3.js");

function keypairFromSeedHex(hex) {
  const trimmed = (hex || "").trim();
  if (trimmed.length !== 64) {
    throw new Error(`Seed must be 64 hex characters, got ${trimmed.length}: AUTHORITY_SEED_*`);
  }
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error("Seed must be hex (0-9, a-f)");
  }
  return Keypair.fromSeed(Buffer.from(trimmed, "hex"));
}

const seed1 = process.env.AUTHORITY_SEED_1;
const seed2 = process.env.AUTHORITY_SEED_2;

if (!seed1 || !seed2) {
  console.error("Missing AUTHORITY_SEED_1 or AUTHORITY_SEED_2 in .env");
  process.exit(1);
}

try {
  const kp1 = keypairFromSeedHex(seed1);
  const kp2 = keypairFromSeedHex(seed2);
  console.log("Admin wallets (from AUTHORITY_SEED_1 / AUTHORITY_SEED_2):\n");
  console.log("ADMIN_1=" + kp1.publicKey.toBase58());
  console.log("ADMIN_2=" + kp2.publicKey.toBase58());
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

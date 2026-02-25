#!/usr/bin/env node
/**
 * Generates two 32-byte seeds (hex) for use with Keypair.fromSeed().
 * Use these for WITHDRAW_AUTHORITY_SEED_1 and WITHDRAW_AUTHORITY_SEED_2 if you
 * want deterministic withdraw authority keypairs from env.
 *
 * Run: node scripts/generate-withdraw-seeds.js
 */
const crypto = require("crypto");
const { Keypair } = require("@solana/web3.js");

function generateSeed() {
  return crypto.randomBytes(32).toString("hex");
}

function keypairFromSeedHex(hex) {
  if (hex.length !== 64) throw new Error("Seed must be 64 hex characters");
  return Keypair.fromSeed(Buffer.from(hex, "hex"));
}

const seed1 = generateSeed();
const seed2 = generateSeed();

console.log("# Add these to your .env (64 hex chars each):\n");
console.log("WITHDRAW_AUTHORITY_SEED_1=" + seed1);
console.log("WITHDRAW_AUTHORITY_SEED_2=" + seed2);

const kp1 = keypairFromSeedHex(seed1);
const kp2 = keypairFromSeedHex(seed2);
console.log("\n# Corresponding public keys (for WITHDRAW_AUTHORITY_1/2 or reference):\n");
console.log("WITHDRAW_AUTHORITY_1=" + kp1.publicKey.toBase58());
console.log("WITHDRAW_AUTHORITY_2=" + kp2.publicKey.toBase58());

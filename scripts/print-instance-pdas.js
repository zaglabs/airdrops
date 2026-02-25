/**
 * Prints the instance config PDA addresses that should be initialized for the
 * fee recipients defined in .env (FEE_RECIPIENT_1, FEE_RECIPIENT_2).
 * Uses the same PDA derivation as the program: seeds = ["instance", fee_recipient].
 *
 * Run: node scripts/print-instance-pdas.js
 * (from repo root; requires .env with FEE_RECIPIENT_1 and FEE_RECIPIENT_2)
 */
require("dotenv").config();
const { PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(
  process.env.AIRDROP_PROGRAM_ID || "HXdbLyrXemG2rSx4YX81Sqt177kZSUB3R9U3K3QMuCm7"
);

function getInstanceConfigPda(feeRecipient) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("instance"), feeRecipient.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

function main() {
  const r1 = process.env.FEE_RECIPIENT_1;
  const r2 = process.env.FEE_RECIPIENT_2;

  if (!r1 || !r2) {
    console.error(
      "Missing FEE_RECIPIENT_1 or FEE_RECIPIENT_2 in .env"
    );
    process.exit(1);
  }

  const feeRecipient1 = new PublicKey(r1);
  const feeRecipient2 = new PublicKey(r2);

  const instancePda1 = getInstanceConfigPda(feeRecipient1);
  const instancePda2 = getInstanceConfigPda(feeRecipient2);

  console.log("Program ID:", PROGRAM_ID.toBase58());
  console.log("");
  console.log("Instance config PDAs (seeds: ['instance', fee_recipient]):");
  console.log("  FEE_RECIPIENT_1:", feeRecipient1.toBase58());
  console.log("    instance_config PDA:", instancePda1.toBase58());
  console.log("");
  console.log("  FEE_RECIPIENT_2:", feeRecipient2.toBase58());
  console.log("    instance_config PDA:", instancePda2.toBase58());
}

main();

// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.
//
// This script runs after the program is deployed and registers 2 fee
// recipients. The deployer must equal INSTANCE_AUTHORITY (in the program);
// they sign as authority and are set as admin of both instances.
//
// Fee recipients: (1) deployer wallet, (2) FEE_RECIPIENT_2 in .env, or a
// PDA (seeds ["fee_recipient_2"]) if unset.

require("dotenv").config();
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair } = require("@solana/web3.js");

module.exports = async function (provider) {
  anchor.setProvider(provider);

  const programId = anchor.workspace.Airdrop.programId;
  const program = anchor.workspace.Airdrop;

  const feeRecipient1 = new PublicKey(process.env.FEE_RECIPIENT_1);
  const feeAmount1 = new anchor.BN(process.env.FEE_AMOUNT_1);
  const feeRecipient2 = new PublicKey(process.env.FEE_RECIPIENT_2);
  const feeAmount2 = new anchor.BN(process.env.FEE_AMOUNT_2);

  const commitment = "confirmed";

  async function ensureInstance(feeRecipient, feeLamports, admin) {
    const [instancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("instance"), feeRecipient.toBuffer()],
      programId,
    );

    const closeTx = await program.methods
      .closeInstance()
      .accounts({
        authority: provider.wallet.publicKey,
        instanceConfig: instancePda,
        feeRecipient,
      })
      .transaction();
    await provider.sendAndConfirm(closeTx, [], {
      commitment,
      preflightCommitment: commitment,
    });

    const tx = await program.methods
      .createInstance(new anchor.BN(feeLamports))
      .accounts({
        authority: provider.wallet.publicKey,
        admin,
        feeRecipient,
        instanceConfig: instancePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .transaction();
    await provider.sendAndConfirm(tx, [], {
      commitment,
      preflightCommitment: commitment,
    });
  }

  const authority1 = Keypair.fromSeed(Buffer.from(process.env.AUTHORITY_SEED_1, "hex"));
  const authority2 = Keypair.fromSeed(Buffer.from(process.env.AUTHORITY_SEED_2, "hex"));
  await ensureInstance(feeRecipient1, feeAmount1, authority1.publicKey);
  await ensureInstance(feeRecipient2, feeAmount2, authority2.publicKey);
};

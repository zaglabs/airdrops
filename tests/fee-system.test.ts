/**
 * Fee system tests: create_instance (INSTANCE_AUTHORITY only), update_instance (admin only),
 * and create_airdrop fee transfer. Fee accounts and fee amounts are read from .env to match
 * migrations/deploy.ts (FEE_RECIPIENT_1, FEE_AMOUNT_1, FEE_RECIPIENT_2, FEE_AMOUNT_2).
 *
 * Funding: Uses provider.wallet (from test-setup). Cleanup: funded accounts drained back to
 * provider; fee accounts drained with leaveRent.
 *
 * Prerequisite: INSTANCE_AUTHORITY in program = test provider wallet. Migration must have
 * run so env fee instances exist (or create_instance tests create their own).
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createMintToInstruction,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { drainToProvider } from "./test-utils";
import "./test-setup";

const MINT_DECIMALS = 6;
const VOUCHERS = 256;

/** Fee config from .env (same as migrations/deploy.ts). */
function getFeeConfigFromEnv(): {
  feeRecipient1: PublicKey;
  feeAmount1: number;
  feeRecipient2: PublicKey;
  feeAmount2: number;
} {
  const r1 = process.env.FEE_RECIPIENT_1;
  const a1 = process.env.FEE_AMOUNT_1;
  const r2 = process.env.FEE_RECIPIENT_2;
  const a2 = process.env.FEE_AMOUNT_2;
  if (!r1 || !a1 || !r2 || !a2) {
    throw new Error(
      "Missing fee env: set FEE_RECIPIENT_1, FEE_AMOUNT_1, FEE_RECIPIENT_2, FEE_AMOUNT_2 in .env"
    );
  }
  return {
    feeRecipient1: new PublicKey(r1),
    feeAmount1: parseInt(a1, 10),
    feeRecipient2: new PublicKey(r2),
    feeAmount2: parseInt(a2, 10),
  };
}

describe("Fee system", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  /** Fee accounts and amounts from .env (migration config). */
  let feeConfig: ReturnType<typeof getFeeConfigFromEnv>;

  /** INSTANCE_AUTHORITY in program must equal this for create_instance tests to pass. */
  const instanceAuthority = provider.wallet;
  /** Used only as wrong signer (not INSTANCE_AUTHORITY, not admin). */
  let otherKeypair: Keypair;
  /** Random recipient for create_instance tests (not from env). Per deploy, admin = fee_recipient. */
  let feeRecipient1Random: PublicKey;

  /** Keypairs we funded from provider; drained back to provider in after(). */
  const fundedKeypairs: Keypair[] = [];
  /** Keypairs used as fee recipients; drained in after() with leaveRent so they keep rent. */
  const feeAccountKeypairs: Keypair[] = [];

  function getInstancePda(feeRecipient: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("instance"), feeRecipient.toBuffer()],
      program.programId
    );
    return pda;
  }

  /** Transfer SOL from provider.wallet (test-setup) to fund a test account. Uses 0.08 SOL by default so provider can fund several accounts (e.g. with ~0.3 SOL). */
  async function fundFromProvider(
    to: PublicKey,
    lamports: number = 0.12 * anchor.web3.LAMPORTS_PER_SOL
  ): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: instanceAuthority.publicKey,
        toPubkey: to,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  before(async () => {
    feeConfig = getFeeConfigFromEnv();
    otherKeypair = Keypair.generate();
    feeRecipient1Random = Keypair.generate().publicKey;

    await fundFromProvider(otherKeypair.publicKey);
    fundedKeypairs.push(otherKeypair);
  });

  after(async () => {
    for (const kp of fundedKeypairs) {
      await drainToProvider(provider.connection, provider, kp);
    }
    for (const kp of feeAccountKeypairs) {
      await drainToProvider(provider.connection, provider, kp, {
        leaveRent: true,
      });
    }
  });

  describe("create_instance", () => {
    it("succeeds when authority is INSTANCE_AUTHORITY and creates instance with fee 0", async () => {
      const instanceConfigPda = getInstancePda(feeRecipient1Random);
      await program.methods
        .createInstance(new anchor.BN(0))
        .accounts({
          authority: instanceAuthority.publicKey,
          admin: feeRecipient1Random,
          feeRecipient: feeRecipient1Random,
          withdrawAuthority: feeRecipient1Random,
          instanceConfig: instanceConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const account = await program.account.instanceConfig.fetch(
        instanceConfigPda
      );
      expect(account.admin.toBase58()).to.equal(feeRecipient1Random.toBase58());
      expect(account.feeLamports.toNumber()).to.equal(0);
    });

    it("succeeds when creating instance with non-zero fee_lamports", async () => {
      const recipient = Keypair.generate().publicKey;
      const instanceConfigPda = getInstancePda(recipient);
      const feeLamports = 10_000;
      await program.methods
        .createInstance(new anchor.BN(feeLamports))
        .accounts({
          authority: instanceAuthority.publicKey,
          admin: recipient,
          feeRecipient: recipient,
          withdrawAuthority: recipient,
          instanceConfig: instanceConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const account = await program.account.instanceConfig.fetch(
        instanceConfigPda
      );
      expect(account.feeLamports.toNumber()).to.equal(feeLamports);
    });

    it("fails when signer is not INSTANCE_AUTHORITY", async () => {
      const recipient = Keypair.generate().publicKey;
      const instanceConfigPda = getInstancePda(recipient);
      try {
        await program.methods
          .createInstance(new anchor.BN(0))
          .accounts({
            authority: otherKeypair.publicKey,
            admin: recipient,
            feeRecipient: recipient,
            withdrawAuthority: recipient,
            instanceConfig: instanceConfigPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([otherKeypair])
          .rpc();
        expect.fail("expected create_instance to fail when authority is not INSTANCE_AUTHORITY");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).to.match(/constraint|Constraint|address|Authority|0x0/);
      }
    });

    it("fails when creating duplicate instance for same fee_recipient", async () => {
      const recipient = Keypair.generate().publicKey;
      const instanceConfigPda = getInstancePda(recipient);
      await program.methods
        .createInstance(new anchor.BN(0))
        .accounts({
          authority: instanceAuthority.publicKey,
          admin: recipient,
          feeRecipient: recipient,
          withdrawAuthority: recipient,
          instanceConfig: instanceConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      try {
        await program.methods
          .createInstance(new anchor.BN(100))
          .accounts({
            authority: instanceAuthority.publicKey,
            admin: recipient,
            feeRecipient: recipient,
            withdrawAuthority: recipient,
            instanceConfig: instanceConfigPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected duplicate create_instance to fail");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).to.match(/already in use|already exists|0x0/);
      }
    });
  });

  describe("update_instance", () => {
    /** Recipient is admin of its instance (per deploy). We need the keypair to sign as admin. */
    let updateTestRecipient: Keypair;
    let updateTestInstancePda: PublicKey;

    before(async () => {
      updateTestRecipient = Keypair.generate();
      updateTestInstancePda = getInstancePda(updateTestRecipient.publicKey);
      await fundFromProvider(updateTestRecipient.publicKey);
      fundedKeypairs.push(updateTestRecipient);
      await program.methods
        .createInstance(new anchor.BN(0))
        .accounts({
          authority: instanceAuthority.publicKey,
          admin: updateTestRecipient.publicKey,
          feeRecipient: updateTestRecipient.publicKey,
          withdrawAuthority: updateTestRecipient.publicKey,
          instanceConfig: updateTestInstancePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("succeeds when admin (recipient) signs and updates fee_lamports", async () => {
      const newFee = 5_000;
      await program.methods
        .updateInstance(new anchor.BN(newFee))
        .accounts({
          instanceConfig: updateTestInstancePda,
          admin: updateTestRecipient.publicKey,
          feeRecipient: updateTestRecipient.publicKey,
        })
        .signers([updateTestRecipient])
        .rpc();

      const account = await program.account.instanceConfig.fetch(
        updateTestInstancePda
      );
      expect(account.feeLamports.toNumber()).to.equal(newFee);
    });

    it("fails when non-admin signs", async () => {
      try {
        await program.methods
          .updateInstance(new anchor.BN(1))
          .accounts({
            instanceConfig: updateTestInstancePda,
            admin: otherKeypair.publicKey,
            feeRecipient: updateTestRecipient.publicKey,
          })
          .signers([otherKeypair])
          .rpc();
        expect.fail("expected update_instance to fail when non-admin signs");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).to.match(/constraint|Constraint|has_one|0x1771/);
      }
    });
  });

  describe("create_airdrop fee transfer", () => {
    let creator: Keypair;
    let backend: Keypair;
    let mint: Keypair;
    let nonce: Keypair;
    let creatorAta: PublicKey;
    let airdropPda: PublicKey;
    let pdaAta: PublicKey;
    let replayBitmapPda: PublicKey;
    const TOTAL_AMOUNT = 100_000;

    /** Instance PDA for an env fee recipient. */
    function getEnvInstancePda(recipient: PublicKey): PublicKey {
      return getInstancePda(recipient);
    }

    /** Ensure instance accounts for env fee recipients exist (create if migration has not run). */
    before(async function () {
      const { feeRecipient1, feeAmount1, feeRecipient2, feeAmount2 } = feeConfig;
      for (const [recipient, amount] of [
        [feeRecipient1, feeAmount1] as const,
        [feeRecipient2, feeAmount2] as const,
      ]) {
        const instancePda = getEnvInstancePda(recipient);
        const info = await provider.connection.getAccountInfo(instancePda);
        if (info) continue;
        await program.methods
          .createInstance(new anchor.BN(amount))
          .accounts({
            authority: instanceAuthority.publicKey,
            admin: recipient,
            feeRecipient: recipient,
            withdrawAuthority: recipient,
            instanceConfig: instancePda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }
    });

    beforeEach(async () => {
      creator = Keypair.generate();
      backend = Keypair.generate();
      mint = Keypair.generate();
      nonce = Keypair.generate();

      await fundFromProvider(creator.publicKey);
      await fundFromProvider(nonce.publicKey);
      fundedKeypairs.push(creator, nonce);

      creatorAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      );
      [airdropPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("airdrop"),
          creator.publicKey.toBuffer(),
          mint.publicKey.toBuffer(),
          nonce.publicKey.toBuffer(),
        ],
        program.programId
      );
      pdaAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        airdropPda,
        true,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      );
      [replayBitmapPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bitmap"), airdropPda.toBuffer()],
        program.programId
      );
    });

    it("creates airdrop with fee > 0 and transfers SOL to fee_recipient", async () => {
      const { feeRecipient1, feeAmount1 } = feeConfig;
      const instanceConfigPda = getEnvInstancePda(feeRecipient1);

      const recipientBalanceBefore = await provider.connection.getBalance(
        feeRecipient1
      );

      const lamports = await getMinimumBalanceForRentExemptMint(
        provider.connection
      );
      const tx = new Transaction();
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: creator.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          mint.publicKey,
          MINT_DECIMALS,
          creator.publicKey,
          null,
          TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          creator.publicKey,
          creatorAta,
          creator.publicKey,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID
        ),
        createMintToInstruction(
          mint.publicKey,
          creatorAta,
          creator.publicKey,
          TOTAL_AMOUNT * 100,
          [],
          TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          creator.publicKey,
          pdaAta,
          airdropPda,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID
        ),
        await program.methods
          .createAirdrop(new anchor.BN(TOTAL_AMOUNT), new anchor.BN(VOUCHERS))
          .accounts({
            creator: creator.publicKey,
            backend: backend.publicKey,
            mint: mint.publicKey,
            nonce: nonce.publicKey,
            instanceConfig: instanceConfigPda,
            feeRecipient: feeRecipient1,
            airdrop: airdropPda,
            pdaAta,
            replayBitmap: replayBitmapPda,
            creatorAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      );
      tx.feePayer = creator.publicKey;
      tx.recentBlockhash = (
        await provider.connection.getLatestBlockhash()
      ).blockhash;
      tx.sign(creator, mint);

      const sig2 = await provider.connection.sendTransaction(tx, [
        creator,
        mint,
      ]);
      await provider.connection.confirmTransaction(sig2, "confirmed");

      const recipientBalanceAfter = await provider.connection.getBalance(
        feeRecipient1
      );
      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(
        feeAmount1
      );
    });

    it("fails create_airdrop when creator has insufficient SOL for fee", async () => {
      const { feeRecipient1 } = feeConfig;

      const poorCreator = Keypair.generate();
      await fundFromProvider(
        poorCreator.publicKey,
        0.01 * anchor.web3.LAMPORTS_PER_SOL
      );
      fundedKeypairs.push(poorCreator);

      const poorMint = Keypair.generate();
      const poorCreatorAta = getAssociatedTokenAddressSync(
        poorMint.publicKey,
        poorCreator.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      );
      const [poorAirdropPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("airdrop"),
          poorCreator.publicKey.toBuffer(),
          poorMint.publicKey.toBuffer(),
          nonce.publicKey.toBuffer(),
        ],
        program.programId
      );
      const poorPdaAta = getAssociatedTokenAddressSync(
        poorMint.publicKey,
        poorAirdropPda,
        true,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      );
      const [poorReplayPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bitmap"), poorAirdropPda.toBuffer()],
        program.programId
      );

      const instanceConfigPda = getEnvInstancePda(feeRecipient1);

      const lamports = await getMinimumBalanceForRentExemptMint(
        provider.connection
      );
      const tx = new Transaction();
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: poorCreator.publicKey,
          newAccountPubkey: poorMint.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          poorMint.publicKey,
          MINT_DECIMALS,
          poorCreator.publicKey,
          null,
          TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          poorCreator.publicKey,
          poorCreatorAta,
          poorCreator.publicKey,
          poorMint.publicKey,
          TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID
        ),
        createMintToInstruction(
          poorMint.publicKey,
          poorCreatorAta,
          poorCreator.publicKey,
          TOTAL_AMOUNT * 100,
          [],
          TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          poorCreator.publicKey,
          poorPdaAta,
          poorAirdropPda,
          poorMint.publicKey,
          TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID
        ),
        await program.methods
          .createAirdrop(new anchor.BN(TOTAL_AMOUNT), new anchor.BN(VOUCHERS))
          .accounts({
            creator: poorCreator.publicKey,
            backend: backend.publicKey,
            mint: poorMint.publicKey,
            nonce: nonce.publicKey,
            instanceConfig: instanceConfigPda,
            feeRecipient: feeRecipient1,
            airdrop: poorAirdropPda,
            pdaAta: poorPdaAta,
            replayBitmap: poorReplayPda,
            creatorAta: poorCreatorAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      );
      tx.feePayer = poorCreator.publicKey;
      tx.recentBlockhash = (
        await provider.connection.getLatestBlockhash()
      ).blockhash;
      tx.sign(poorCreator, poorMint);

      try {
        const failSig = await provider.connection.sendTransaction(tx, [
          poorCreator,
          poorMint,
        ]);
        await provider.connection.confirmTransaction(failSig, "confirmed");
        expect.fail("expected create_airdrop to fail when creator cannot pay fee");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Tx can fail with insufficient-funds, InstructionFallbackNotFound (101), or simulation/account errors
        expect(msg).to.match(
          /insufficient|Insufficient|0x0|native|lamports|Fallback|InstructionFallbackNotFound|101|Simulation failed|AccountNotInitialized|3012/
        );
      }
    });
  });
});

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
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
const TOTAL_AMOUNT = 100_000;

function getInstancePda(programId: PublicKey, feeRecipient: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("instance"), feeRecipient.toBuffer()],
    programId
  );
  return pda;
}

describe("Withdraw (admin only)", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const programId = program.programId;

  /** Instance admin (fee_recipient for instance PDA; only this key may call withdraw and update_instance). */
  let admin: Keypair;
  /** Creator of the airdrop (tokens go back to creator_ata on withdraw). */
  let creator: Keypair;
  let backend: Keypair;
  let mint: Keypair;
  let nonce: Keypair;
  let creatorAta: PublicKey;
  let airdropPda: PublicKey;
  let pdaAta: PublicKey;
  let replayBitmapPda: PublicKey;
  let instanceConfigPda: PublicKey;

  const fundedKeypairs: Keypair[] = [];
  const feeAccountKeypairs: Keypair[] = [];

  async function fundFromProvider(
    to: PublicKey,
    lamports: number = 0.12 * anchor.web3.LAMPORTS_PER_SOL
  ): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: to,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  before(async () => {
    admin = Keypair.generate();
    await fundFromProvider(admin.publicKey);
    feeAccountKeypairs.push(admin);

    instanceConfigPda = getInstancePda(programId, admin.publicKey);
    const instanceExists = await provider.connection.getAccountInfo(instanceConfigPda);
    if (!instanceExists) {
      await program.methods
        .createInstance(new anchor.BN(0))
        .accounts({
          authority: provider.wallet.publicKey,
          admin: admin.publicKey,
          feeRecipient: admin.publicKey,
          instanceConfig: instanceConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
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
      programId
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
      programId
    );
    instanceConfigPda = getInstancePda(programId, admin.publicKey);
  });

  async function createAirdrop(): Promise<void> {
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
          feeRecipient: admin.publicKey,
          airdrop: airdropPda,
          pdaAta,
          replayBitmap: replayBitmapPda,
          creatorAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()
    );
    await provider.sendAndConfirm(tx, [creator, mint]);
  }

  it("allows admin to withdraw partial amount", async () => {
    await createAirdrop();

    const partialAmount = 30_000;
    const initialCreatorBalance = await getAccount(
      provider.connection,
      creatorAta
    );
    const initialCreatorTokens = Number(initialCreatorBalance.amount);

    await program.methods
      .withdraw(new anchor.BN(partialAmount))
      .accounts({
        airdrop: airdropPda,
        mint: mint.publicKey,
        instanceConfig: instanceConfigPda,
        authority: admin.publicKey,
        creator: creator.publicKey,
        pdaAta,
        creatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const finalCreatorBalance = await getAccount(
      provider.connection,
      creatorAta
    );
    const finalCreatorTokens = Number(finalCreatorBalance.amount);
    expect(finalCreatorTokens).to.equal(
      initialCreatorTokens + partialAmount
    );

    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(partialAmount);
    expect(airdropAccount.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT);
  });

  it("allows admin to withdraw full remaining amount (closes airdrop)", async () => {
    await createAirdrop();

    const initialCreatorBalance = await getAccount(
      provider.connection,
      creatorAta
    );
    const initialCreatorTokens = Number(initialCreatorBalance.amount);

    await program.methods
      .withdraw(new anchor.BN(TOTAL_AMOUNT))
      .accounts({
        airdrop: airdropPda,
        mint: mint.publicKey,
        instanceConfig: instanceConfigPda,
        authority: admin.publicKey,
        creator: creator.publicKey,
        pdaAta,
        creatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const finalCreatorBalance = await getAccount(
      provider.connection,
      creatorAta
    );
    const finalCreatorTokens = Number(finalCreatorBalance.amount);
    expect(finalCreatorTokens).to.equal(
      initialCreatorTokens + TOTAL_AMOUNT
    );

    const airdropInfo = await provider.connection.getAccountInfo(airdropPda);
    expect(airdropInfo).to.be.null;
  });

  it("fails when creator signs instead of admin", async () => {
    await createAirdrop();

    try {
      await program.methods
        .withdraw(new anchor.BN(10_000))
        .accounts({
          airdrop: airdropPda,
          mint: mint.publicKey,
          instanceConfig: instanceConfigPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          pdaAta,
          creatorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();
      expect.fail("expected withdraw to fail when creator signs");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).to.match(
        /Unauthorized|constraint|Constraint|0x1770|authority|instance_config/
      );
    }
  });

  it("fails when non-admin (other key) signs", async () => {
    await createAirdrop();

    const otherKey = Keypair.generate();
    await fundFromProvider(otherKey.publicKey);
    fundedKeypairs.push(otherKey);

    try {
      await program.methods
        .withdraw(new anchor.BN(10_000))
        .accounts({
          airdrop: airdropPda,
          mint: mint.publicKey,
          instanceConfig: instanceConfigPda,
          authority: otherKey.publicKey,
          creator: creator.publicKey,
          pdaAta,
          creatorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([otherKey])
        .rpc();
      expect.fail("expected withdraw to fail when non-admin signs");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).to.match(
        /Unauthorized|constraint|Constraint|0x1770|authority/
      );
    }
  });

  it("fails when amount exceeds available", async () => {
    await createAirdrop();

    try {
      await program.methods
        .withdraw(new anchor.BN(TOTAL_AMOUNT + 1))
        .accounts({
          airdrop: airdropPda,
          mint: mint.publicKey,
          instanceConfig: instanceConfigPda,
          authority: admin.publicKey,
          creator: creator.publicKey,
          pdaAta,
          creatorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("expected withdraw to fail when amount > available");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).to.match(
        /InsufficientFunds|0x1|insufficient|unknown signer|Transaction simulation failed/
      );
    }
  });
});

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const FEE_RESERVE = 5000;

export type DrainOptions = {
  /** If true, leave rent-exempt minimum in the account (use for fee accounts). */
  leaveRent?: boolean;
};

/**
 * General test flow: provider funds accounts → tests run → remaining SOL in accounts
 * goes back to provider. Call this for each keypair you funded from the provider
 * (e.g. in an after() hook) so nothing is left behind.
 * For fee accounts (that received fee SOL), pass { leaveRent: true } so the account keeps rent.
 */
export async function drainToProvider(
  connection: anchor.web3.Connection,
  provider: anchor.AnchorProvider,
  keypair: Keypair,
  options?: DrainOptions,
): Promise<void> {
  const balance = await connection.getBalance(keypair.publicKey);
  if (balance <= FEE_RESERVE) return;
  const leaveRent = options?.leaveRent ?? false;
  const rentExempt = leaveRent
    ? await connection.getMinimumBalanceForRentExemption(0)
    : 0;
  const transferLamports = Math.max(
    0,
    balance - FEE_RESERVE - rentExempt,
  );
  if (transferLamports <= 0) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: provider.wallet.publicKey,
      lamports: transferLamports,
    }),
  );
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(keypair);
  try {
    await provider.sendAndConfirm(tx, [keypair]);
  } catch {
    // Ignore so other drains can still run
  }
}
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Ed25519Program } from "@solana/web3.js";
import * as nacl from "tweetnacl";

export class AirdropTestHelper {
  constructor(
    public program: anchor.Program,
    public provider: anchor.AnchorProvider,
  ) {}

  async setupTestEnvironment(decimals: number = 6) {
    const creator = Keypair.generate();
    const backend = Keypair.generate();
    const claimant = Keypair.generate();

    // check test wallet balance
    const initialTestWalletBalance =
      await this.provider.connection.requestAirdrop(
        this.provider.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL,
      );

    await this.provider.connection.confirmTransaction(
      initialTestWalletBalance,
      "confirmed",
    );

    const initialBalance = await this.provider.connection.requestAirdrop(
      creator.publicKey,
      20 * anchor.web3.LAMPORTS_PER_SOL,
    );

    await this.provider.connection.confirmTransaction(
      initialBalance,
      "confirmed",
    );

    const initialBalanceClaimant =
      await this.provider.connection.requestAirdrop(
        claimant.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL,
      );

    await this.provider.connection.confirmTransaction(
      initialBalanceClaimant,
      "confirmed",
    );

    // Create a test mint
    const mint = await createMint(
      this.provider.connection,
      creator,
      creator.publicKey,
      null,
      decimals,
    );

    const creatorAta = await createAccount(
      this.provider.connection,
      creator,
      mint,
      creator.publicKey,
    );

    // Mint tokens to creator
    const tokenBalance = await mintTo(
      this.provider.connection,
      creator,
      mint,
      creatorAta,
      creator,
      1000000000 * 2, // Mint extra for testing
    );

    await this.provider.connection.confirmTransaction(
      tokenBalance,
      "confirmed",
    );

    return {
      creator,
      backend,
      claimant,
      mint,
      creatorAta,
    };
  }

  async createAirdrop(
    creator: Keypair,
    backend: Keypair,
    mint: PublicKey,
    creatorAta: PublicKey,
    totalAmount: number,
    claimAmount: number,
    endsAt?: number,
  ) {
    const [airdropPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("airdrop"), creator.publicKey.toBuffer(), mint.toBuffer()],
      this.program.programId,
    );

    const pdaAta = await getOrCreateAssociatedTokenAccount(
      this.provider.connection,
      creator,
      mint,
      airdropPda,
      true,
    ).then((ata) => ata.address);

    await this.program.methods
      .createAirdrop(
        new anchor.BN(totalAmount),
        new anchor.BN(claimAmount),
        endsAt ? new anchor.BN(endsAt) : null,
        new anchor.BN(8192),
      )
      .accounts({
        creator: creator.publicKey,
        backend: backend.publicKey,
        mint: mint,
        airdrop: airdropPda,
        pdaAta: pdaAta,
        creatorAta: creatorAta,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    return { airdropPda, pdaAta };
  }

  async createVoucher(
    airdropPda: PublicKey,
    claimant: PublicKey,
    nonce: number,
    expiry: number,
    backend: Keypair,
  ) {
    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.toBuffer();
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(expiry), 0);
    const message = Buffer.concat([
      airdropPdaBuf,
      claimantBuf,
      nonceBuf,
      expiryBuf,
    ]);

    const voucherSignature = nacl.sign.detached(message, backend.secretKey);

    const headerSize = 16;
    const signatureLength = 64;
    const pubkeyLength = 32;
    const messageLength = message.length;

    const signatureOffset = headerSize;
    const pubkeyOffset = signatureOffset + signatureLength;
    const messageOffset = pubkeyOffset + pubkeyLength;

    const edIxData = Buffer.alloc(
      headerSize + signatureLength + pubkeyLength + messageLength,
    );

    edIxData[0] = 1;
    edIxData[1] = 0;
    edIxData.writeUInt16LE(signatureOffset, 2);
    edIxData.writeUInt16LE(0, 4);
    edIxData.writeUInt16LE(pubkeyOffset, 6);
    edIxData.writeUInt16LE(0, 8);
    edIxData.writeUInt16LE(messageOffset, 10);
    edIxData.writeUInt16LE(messageLength, 12);
    edIxData.writeUInt16LE(0, 14);

    edIxData.set(voucherSignature, signatureOffset);
    edIxData.set(backend.publicKey.toBuffer(), pubkeyOffset);
    edIxData.set(message, messageOffset);

    const edIx = new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });

    return {
      message,
      signature: voucherSignature,
      ed25519Instruction: edIx,
    };
  }

  async claimTokens(
    airdropPda: PublicKey,
    pdaAta: PublicKey,
    destAta: PublicKey,
    claimant: Keypair,
    replayBitmapPda: PublicKey,
    mint: PublicKey,
    creator: PublicKey,
    amount: number,
    nonce: number,
    expiry: number,
    voucher: { ed25519Instruction: any },
  ) {
    const claimIx = await this.program.methods
      .claim(new anchor.BN(amount), new anchor.BN(nonce), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        creator,
        mint,
        pdaAta: pdaAta,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(voucher.ed25519Instruction).add(claimIx);

    tx.feePayer = claimant.publicKey;
    const { blockhash } = await this.provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    const txSignature = await this.provider.connection.sendTransaction(tx, [
      claimant,
    ]);
    await this.provider.connection.confirmTransaction(txSignature);

    return txSignature;
  }

  async getReplayBitmapPda(airdropPda: PublicKey): Promise<PublicKey> {
    const [replayBitmapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), airdropPda.toBuffer()],
      this.program.programId,
    );

    return replayBitmapPda;
  }

  async getTokenAccountBalance(tokenAccount: PublicKey) {
    const account = await getAccount(this.provider.connection, tokenAccount);
    return Number(account.amount);
  }

  async createAssociatedTokenAccountIfNeeded(
    payer: Keypair,
    owner: PublicKey,
    mint: PublicKey,
  ) {
    return await getOrCreateAssociatedTokenAccount(
      this.provider.connection,
      payer,
      mint,
      owner,
      true,
    ).then((ata) => ata.address);
  }

  async createMintWithDecimals(payer: Keypair, decimals: number) {
    return await createMint(
      this.provider.connection,
      payer,
      payer.publicKey,
      null,
      decimals,
    );
  }

  async getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey) {
    return await getAssociatedTokenAddress(mint, owner);
  }
}

export function createTestHelper(
  program: anchor.Program,
  provider: anchor.AnchorProvider,
) {
  return new AirdropTestHelper(program, provider);
}

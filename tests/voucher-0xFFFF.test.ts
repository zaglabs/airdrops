import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  createMintToInstruction,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Ed25519Program } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { expect } from "chai";
import "./test-setup";

/**
 * Index-independent vouchers: use 0xFFFF for all three ed25519 instruction
 * indices so the voucher is valid regardless of where it appears in the
 * transaction (e.g. after compute budget or priority fee instructions).
 */
const ED25519_INDEX_SENTINEL = 0xffff;

describe("Claim with 0xFFFF index-independent vouchers", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider();

  let creator: Keypair;
  let backend: Keypair;
  let claimant: Keypair;
  let mint: Keypair;
  let nonce: Keypair;
  let creatorAta: PublicKey;
  let airdropPda: PublicKey;
  let pdaAta: PublicKey;
  let replayBitmapPda: PublicKey;
  let destAta: PublicKey;

  const TOTAL_AMOUNT = 1000000;
  const MINT_DECIMALS = 6;
  const VOUCHERS = 8192;

  before(async () => {
    creator = Keypair.generate();
    backend = Keypair.generate();
    claimant = Keypair.generate();
    nonce = Keypair.generate();

    const airdropSigs = await Promise.all(
      [
        provider.publicKey,
        creator.publicKey,
        claimant.publicKey,
        nonce.publicKey,
      ].map((pubkey) =>
        provider.connection.requestAirdrop(
          pubkey,
          0.5 * anchor.web3.LAMPORTS_PER_SOL
        )
      )
    );
    for (const sig of airdropSigs) {
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    const [instanceConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("instance"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );
    const instanceAccount = await provider.connection.getAccountInfo(
      instanceConfigPda
    );
    if (!instanceAccount) {
      await program.methods
        .createInstance(new anchor.BN(0))
        .accounts({
          authority: provider.wallet.publicKey,
          admin: provider.wallet.publicKey,
          feeRecipient: provider.wallet.publicKey,
          withdrawAuthority: provider.wallet.publicKey,
          instanceConfig: instanceConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  beforeEach(async () => {
    mint = Keypair.generate();
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

    const [instanceConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("instance"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const lamports = await getMinimumBalanceForRentExemptMint(
      provider.connection
    );

    const createAirdropIx = await program.methods
      .createAirdrop(new anchor.BN(TOTAL_AMOUNT), new anchor.BN(VOUCHERS))
      .accounts({
        creator: creator.publicKey,
        backend: backend.publicKey,
        mint: mint.publicKey,
        nonce: nonce.publicKey,
        instanceConfig: instanceConfigPda,
        feeRecipient: provider.wallet.publicKey,
        airdrop: airdropPda,
        pdaAta,
        replayBitmap: replayBitmapPda,
        creatorAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(
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
      createAirdropIx
    );

    tx.feePayer = creator.publicKey;
    tx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    tx.sign(creator);

    const setupSig = await provider.connection.sendTransaction(tx, [
      creator,
      mint,
    ]);
    await provider.connection.confirmTransaction(setupSig, "confirmed");

    destAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      claimant,
      mint.publicKey,
      claimant.publicKey,
      false
    ).then((ata) => ata.address);
  });

  /**
   * Builds an ed25519 voucher instruction with 0xFFFF for all three
   * instruction indices (signature, pubkey, message).
   * @param signer - keypair used to sign and whose pubkey is in the instruction (default: backend)
   */
  function createVoucher0xFFFF(
    airdropPdaKey: PublicKey,
    claimantKey: PublicKey,
    amount: number,
    nonceVal: number,
    expiry: number,
    signer: Keypair = backend
  ): anchor.web3.TransactionInstruction {
    const message = Buffer.concat([
      airdropPdaKey.toBuffer(),
      claimantKey.toBuffer(),
      Buffer.alloc(8),
      Buffer.alloc(8),
      Buffer.alloc(8),
    ]);
    message.writeBigUInt64LE(BigInt(amount), 32 + 32);
    message.writeBigUInt64LE(BigInt(nonceVal), 32 + 32 + 8);
    message.writeBigInt64LE(BigInt(expiry), 32 + 32 + 8 + 8);

    const signature = nacl.sign.detached(message, signer.secretKey);

    const headerSize = 16;
    const signatureLength = 64;
    const pubkeyLength = 32;
    const messageLength = message.length;

    const signatureOffset = headerSize;
    const pubkeyOffset = signatureOffset + signatureLength;
    const messageOffset = pubkeyOffset + pubkeyLength;

    const edIxData = Buffer.alloc(
      headerSize + signatureLength + pubkeyLength + messageLength
    );

    edIxData[0] = 1;
    edIxData[1] = 0;
    edIxData.writeUInt16LE(signatureOffset, 2);
    edIxData.writeUInt16LE(ED25519_INDEX_SENTINEL, 4);
    edIxData.writeUInt16LE(pubkeyOffset, 6);
    edIxData.writeUInt16LE(ED25519_INDEX_SENTINEL, 8);
    edIxData.writeUInt16LE(messageOffset, 10);
    edIxData.writeUInt16LE(messageLength, 12);
    edIxData.writeUInt16LE(ED25519_INDEX_SENTINEL, 14);

    edIxData.set(signature, signatureOffset);
    edIxData.set(signer.publicKey.toBuffer(), pubkeyOffset);
    edIxData.set(message, messageOffset);

    return new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });
  }

  /**
   * Builds an ed25519 voucher instruction with 0xFFFF and a custom message (e.g. wrong format).
   */
  function createVoucher0xFFFFWithMessage(
    message: Buffer,
    signer: Keypair = backend
  ): anchor.web3.TransactionInstruction {
    const signature = nacl.sign.detached(message, signer.secretKey);

    const headerSize = 16;
    const signatureLength = 64;
    const pubkeyLength = 32;
    const messageLength = message.length;

    const signatureOffset = headerSize;
    const pubkeyOffset = signatureOffset + signatureLength;
    const messageOffset = pubkeyOffset + pubkeyLength;

    const edIxData = Buffer.alloc(
      headerSize + signatureLength + pubkeyLength + messageLength
    );

    edIxData[0] = 1;
    edIxData[1] = 0;
    edIxData.writeUInt16LE(signatureOffset, 2);
    edIxData.writeUInt16LE(ED25519_INDEX_SENTINEL, 4);
    edIxData.writeUInt16LE(pubkeyOffset, 6);
    edIxData.writeUInt16LE(ED25519_INDEX_SENTINEL, 8);
    edIxData.writeUInt16LE(messageOffset, 10);
    edIxData.writeUInt16LE(messageLength, 12);
    edIxData.writeUInt16LE(ED25519_INDEX_SENTINEL, 14);

    edIxData.set(signature, signatureOffset);
    edIxData.set(signer.publicKey.toBuffer(), pubkeyOffset);
    edIxData.set(message, messageOffset);

    return new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });
  }

  async function claimWithInstructions(
    instructions: anchor.web3.TransactionInstruction[]
  ): Promise<string> {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = claimant.publicKey;
    tx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    tx.sign(claimant);

    const sig = await provider.connection.sendTransaction(tx, [claimant]);
    await provider.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  it("claims successfully when voucher (0xFFFF) is the first instruction", async () => {
    const amount = 50000;
    const nonceVal = 1;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const edIx = createVoucher0xFFFF(
      airdropPda,
      claimant.publicKey,
      amount,
      nonceVal,
      expiry
    );
    const claimIx = await program.methods
      .claim(
        new anchor.BN(amount),
        new anchor.BN(nonceVal),
        new anchor.BN(expiry)
      )
      .accounts({
        airdrop: airdropPda,
        pdaAta,
        destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    await claimWithInstructions([edIx, claimIx]);

    const destAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAccount.amount)).to.equal(amount);
  });

  it("claims successfully when voucher (0xFFFF) is after compute budget instructions", async () => {
    const amount = 75000;
    const nonceVal = 2;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 10_000,
    });

    const edIx = createVoucher0xFFFF(
      airdropPda,
      claimant.publicKey,
      amount,
      nonceVal,
      expiry
    );
    const claimIx = await program.methods
      .claim(
        new anchor.BN(amount),
        new anchor.BN(nonceVal),
        new anchor.BN(expiry)
      )
      .accounts({
        airdrop: airdropPda,
        pdaAta,
        destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    await claimWithInstructions([
      computeLimitIx,
      computePriceIx,
      edIx,
      claimIx,
    ]);

    const destAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAccount.amount)).to.equal(amount);
  });

  it("rejects claim when voucher message does not match (wrong amount)", async () => {
    const voucherAmount = 10000;
    const claimAmount = 20000;
    const nonceVal = 3;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const edIx = createVoucher0xFFFF(
      airdropPda,
      claimant.publicKey,
      voucherAmount,
      nonceVal,
      expiry
    );
    const claimIx = await program.methods
      .claim(
        new anchor.BN(claimAmount),
        new anchor.BN(nonceVal),
        new anchor.BN(expiry)
      )
      .accounts({
        airdrop: airdropPda,
        pdaAta,
        destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    try {
      await claimWithInstructions([edIx, claimIx]);
      expect.fail("Claim with wrong amount should have failed");
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : String(err);
      expect(msg).to.match(/InvalidVoucher|0x3|invalid voucher/i);
    }
  });

  it("rejects claim when voucher is signed by wrong backend (wrong secret)", async () => {
    const wrongBackend = Keypair.generate();
    const amount = 10000;
    const nonceVal = 4;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const edIx = createVoucher0xFFFF(
      airdropPda,
      claimant.publicKey,
      amount,
      nonceVal,
      expiry,
      wrongBackend
    );
    const claimIx = await program.methods
      .claim(
        new anchor.BN(amount),
        new anchor.BN(nonceVal),
        new anchor.BN(expiry)
      )
      .accounts({
        airdrop: airdropPda,
        pdaAta,
        destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    try {
      await claimWithInstructions([edIx, claimIx]);
      expect.fail("Claim with wrong backend secret should have failed");
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : String(err);
      expect(msg).to.match(/InvalidVoucher|0x3|invalid voucher/i);
    }
  });

  it("rejects claim when voucher has wrong message format (missing expiry)", async () => {
    const amount = 10000;
    const nonceVal = 5;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const wrongFormatMessage = Buffer.concat([
      airdropPda.toBuffer(),
      claimant.publicKey.toBuffer(),
      Buffer.alloc(8),
      Buffer.alloc(8),
      Buffer.alloc(8),
    ]);
    wrongFormatMessage.writeBigUInt64LE(BigInt(amount), 32 + 32);
    wrongFormatMessage.writeBigUInt64LE(BigInt(nonceVal), 32 + 32 + 8);
    wrongFormatMessage.writeBigInt64LE(BigInt(expiry), 32 + 32 + 8 + 8);
    const truncatedMessage = wrongFormatMessage.subarray(0, 80);

    const edIx = createVoucher0xFFFFWithMessage(truncatedMessage);
    const claimIx = await program.methods
      .claim(
        new anchor.BN(amount),
        new anchor.BN(nonceVal),
        new anchor.BN(expiry)
      )
      .accounts({
        airdrop: airdropPda,
        pdaAta,
        destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    try {
      await claimWithInstructions([edIx, claimIx]);
      expect.fail("Claim with wrong voucher format should have failed");
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : String(err);
      expect(msg).to.match(/InvalidVoucher|0x3|invalid voucher/i);
    }
  });
});

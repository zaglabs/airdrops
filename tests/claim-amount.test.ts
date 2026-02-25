import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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

describe("Claim with Amount Parameter", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider();

  // Test accounts
  let creator: Keypair;
  let backend: Keypair;
  let claimant: Keypair;
  let mint: Keypair;
  let creatorAta: PublicKey;
  let airdropPda: PublicKey;
  let pdaAta: PublicKey;
  let destAta: PublicKey;
  let replayBitmapPda: PublicKey;
  
  // Test constants
  const TOTAL_AMOUNT = 1000000; // 1 token (with 6 decimals)
  const MINT_DECIMALS = 6;

  before(async () => {
    // Generate test keypairs
    creator = Keypair.generate();
    backend = Keypair.generate();
    claimant = Keypair.generate();

    // Airdrop SOL for transaction fees
    const initialTestWalletBalance = await provider.connection.requestAirdrop(
      provider.publicKey,
      0.5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(
      initialTestWalletBalance,
      "confirmed"
    );

    const initialBalance = await provider.connection.requestAirdrop(
      creator.publicKey,
      0.5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(initialBalance, "confirmed");

    const initialBalanceClaimant = await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(
      initialBalanceClaimant,
      "confirmed"
    );
  });

  beforeEach(async () => {
    // Create a new mint and airdrop for each test
    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection);
    mint = Keypair.generate();
    creatorAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      creator.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    );

    [airdropPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("airdrop"), creator.publicKey.toBuffer(), mint.publicKey.toBuffer()],
      program.programId
    );

    pdaAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      airdropPda,
      true,
      TOKEN_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    );

    [replayBitmapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), airdropPda.toBuffer()],
      program.programId
    );

    const endsAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const vouchers = 8192;

    const createAirdropIx = await program.methods
      .createAirdrop(
        new anchor.BN(TOTAL_AMOUNT),
        new anchor.BN(endsAt),
        new anchor.BN(vouchers)
      )
      .accounts({
        creator: creator.publicKey,
        backend: backend.publicKey,
        mint: mint.publicKey,
        creatorAta: creatorAta,
        airdrop: airdropPda,
        pdaAta: pdaAta,
        replayBitmap: replayBitmapPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const tx = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: creator.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint.publicKey, MINT_DECIMALS, creator.publicKey, null, TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(
          creator.publicKey,
          creatorAta,
          creator.publicKey,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        ),
        createMintToInstruction(mint.publicKey, creatorAta, creator.publicKey, TOTAL_AMOUNT * 100, [], TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(
          creator.publicKey,
          pdaAta,
          airdropPda,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        ),
        createAirdropIx
      );

    tx.feePayer = creator.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(creator);
    
    const txSignature = await provider.connection.sendTransaction(tx, [creator, mint]);
    await provider.connection.confirmTransaction(txSignature);

    destAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      claimant,
      mint.publicKey,
      claimant.publicKey,
      false
    ).then((ata) => ata.address);
  });

  // Helper function to create a voucher
  // Message format: airdrop_pda (32) || claimant_pubkey (32) || amount (u64 LE) || nonce (u64 LE) || expiry (i64 LE)
  function createVoucher(
    airdropPda: PublicKey,
    claimant: PublicKey,
    amount: number,
    nonce: number,
    expiry: number
  ) {
    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.toBuffer();
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(amount), 0);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(expiry), 0);
    const message = Buffer.concat([
      airdropPdaBuf,
      claimantBuf,
      amountBuf,
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
      headerSize + signatureLength + pubkeyLength + messageLength
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

    return new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });
  }

  // Helper function to claim tokens
  async function claimTokens(
    amount: number,
    nonce: number,
    expiry: number
  ) {
    const edIx = createVoucher(airdropPda, claimant.publicKey, amount, nonce, expiry);

    const claimIx = await program.methods
      .claim(new anchor.BN(amount), new anchor.BN(nonce), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        pdaAta: pdaAta,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(claimIx);
    tx.feePayer = claimant.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    const txSignature = await provider.connection.sendTransaction(tx, [claimant]);
    await provider.connection.confirmTransaction(txSignature);
    return txSignature;
  }

  it("Successfully claims with a small amount", async () => {
    const claimAmount = 10000; // 0.01 tokens
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    await claimTokens(claimAmount, nonce, expiry);

    // Verify tokens were transferred
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(claimAmount);

    // Verify airdrop account was updated
    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(claimAmount);
  });

  it("Successfully claims with a large amount", async () => {
    const claimAmount = 500000; // 0.5 tokens
    const nonce = 2;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    await claimTokens(claimAmount, nonce, expiry);

    // Verify tokens were transferred
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(claimAmount);

    // Verify airdrop account was updated
    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(claimAmount);
  });

  it("Successfully claims multiple times with different amounts", async () => {
    const amounts = [10000, 50000, 100000];
    const nonces = [10, 11, 12];
    const expiry = Math.floor(Date.now() / 1000) + 300;

    let totalClaimed = 0;
    for (let i = 0; i < amounts.length; i++) {
      await claimTokens(amounts[i], nonces[i], expiry);
      totalClaimed += amounts[i];
    }

    // Verify final balance
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(totalClaimed);

    // Verify airdrop account was updated
    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(totalClaimed);
  });

  it("Fails to claim when amount exceeds available funds", async () => {
    const claimAmount = TOTAL_AMOUNT + 1; // More than total
    const nonce = 20;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const edIx = createVoucher(airdropPda, claimant.publicKey, claimAmount, nonce, expiry);

    const claimIx = await program.methods
      .claim(new anchor.BN(claimAmount), new anchor.BN(nonce), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        pdaAta: pdaAta,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(claimIx);
    tx.feePayer = claimant.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed");
    } catch (error: any) {
      expect(error.message).to.include("InsufficientFunds");
    }
  });

  it("Fails to claim when amount would exceed remaining funds after partial claims", async () => {
    const firstClaim = 300000; // Claim 0.3 tokens first
    const secondClaim = 800000; // Try to claim 0.8 tokens (would exceed remaining 0.7)
    const nonce1 = 30;
    const nonce2 = 31;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    // First claim succeeds
    await claimTokens(firstClaim, nonce1, expiry);

    // Second claim should fail
    const edIx = createVoucher(airdropPda, claimant.publicKey, secondClaim, nonce2, expiry);

    const claimIx = await program.methods
      .claim(new anchor.BN(secondClaim), new anchor.BN(nonce2), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        pdaAta: pdaAta,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(claimIx);
    tx.feePayer = claimant.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed");
    } catch (error: any) {
      expect(error.message).to.include("InsufficientFunds");
    }

    // Verify first claim still went through
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(firstClaim);
  });

  it("Successfully claims the exact remaining amount", async () => {
    const firstClaim = 300000; // Claim 0.3 tokens first
    const remainingAmount = TOTAL_AMOUNT - firstClaim; // Remaining 0.7 tokens
    const nonce1 = 40;
    const nonce2 = 41;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    // First claim
    await claimTokens(firstClaim, nonce1, expiry);

    // Claim the exact remaining amount
    await claimTokens(remainingAmount, nonce2, expiry);

    // Verify final balance
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(TOTAL_AMOUNT);

    // Verify airdrop account was fully claimed
    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(TOTAL_AMOUNT);
  });

  it("Fails to claim with zero amount", async () => {
    const claimAmount = 0;
    const nonce = 50;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const edIx = createVoucher(airdropPda, claimant.publicKey, claimAmount, nonce, expiry);

    const claimIx = await program.methods
      .claim(new anchor.BN(claimAmount), new anchor.BN(nonce), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        pdaAta: pdaAta,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(claimIx);
    tx.feePayer = claimant.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed");
    } catch (error: any) {
      // Should fail with InvalidAmount error
      expect(error.message).to.include("InvalidAmount");
    }
  });

  it("Allows claiming with amount = 1 (minimum non-zero)", async () => {
    const claimAmount = 1; // Minimum amount
    const nonce = 60;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    await claimTokens(claimAmount, nonce, expiry);

    // Verify tokens were transferred
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(claimAmount);

    // Verify airdrop account was updated
    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(claimAmount);
  });

  it("Fails to claim when amount differs from voucher (security test)", async () => {
    // Create voucher for 10000 tokens
    const voucherAmount = 10000;
    const claimAmount = 50000; // Try to claim more than authorized
    const nonce = 90;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    // Create voucher with the authorized amount
    const edIx = createVoucher(airdropPda, claimant.publicKey, voucherAmount, nonce, expiry);

    // Try to claim a different amount
    const claimIx = await program.methods
      .claim(new anchor.BN(claimAmount), new anchor.BN(nonce), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        pdaAta: pdaAta,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(claimIx);
    tx.feePayer = claimant.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed - amount mismatch");
    } catch (error: any) {
      // Should fail because the voucher was signed for a different amount
      expect(error.message).to.include("InvalidVoucher");
    }
  });

  it("Correctly tracks claimed amounts across multiple claims", async () => {
    const amounts = [10000, 25000, 50000, 100000];
    const nonces = [70, 71, 72, 73];
    const expiry = Math.floor(Date.now() / 1000) + 300;

    let expectedTotal = 0;
    for (let i = 0; i < amounts.length; i++) {
      await claimTokens(amounts[i], nonces[i], expiry);
      expectedTotal += amounts[i];

      // Verify running total after each claim
      const airdropAccount = await program.account.airdrop.fetch(airdropPda);
      expect(airdropAccount.claimedAmount.toNumber()).to.equal(expectedTotal);
    }

    // Final verification
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(expectedTotal);

    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(expectedTotal);
    expect(airdropAccount.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT);
  });

  it("Handles edge case: claiming all remaining funds exactly", async () => {
    // Claim almost everything first
    const firstClaim = TOTAL_AMOUNT - 1000;
    const remainingClaim = 1000;
    const nonce1 = 80;
    const nonce2 = 81;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    await claimTokens(firstClaim, nonce1, expiry);

    // Verify remaining
    const airdropAccount1 = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount1.claimedAmount.toNumber()).to.equal(firstClaim);
    expect(airdropAccount1.totalAmount.toNumber() - airdropAccount1.claimedAmount.toNumber()).to.equal(remainingClaim);

    // Claim the exact remainder
    await claimTokens(remainingClaim, nonce2, expiry);

    // Verify fully claimed
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(TOTAL_AMOUNT);

    const airdropAccount2 = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount2.claimedAmount.toNumber()).to.equal(TOTAL_AMOUNT);
  });
});

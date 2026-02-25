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

describe("Multiple Airdrops with Same Creator and Mint", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider();

  // Test accounts
  let creator: Keypair;
  let backend: Keypair;
  let claimant: Keypair;
  let mint: Keypair;
  let creatorAta: PublicKey;

  // Airdrop 1
  let nonce1: Keypair;
  let airdropPda1: PublicKey;
  let pdaAta1: PublicKey;
  let replayBitmapPda1: PublicKey;

  // Airdrop 2
  let nonce2: Keypair;
  let airdropPda2: PublicKey;
  let pdaAta2: PublicKey;
  let replayBitmapPda2: PublicKey;

  let destAta: PublicKey;

  // Test constants
  const TOTAL_AMOUNT_1 = 1000000; // 1 token (with 6 decimals)
  const TOTAL_AMOUNT_2 = 2000000; // 2 tokens
  const MINT_DECIMALS = 6;

  before(async () => {
    // Generate test keypairs
    creator = Keypair.generate();
    backend = Keypair.generate();
    claimant = Keypair.generate();
    nonce1 = Keypair.generate();
    nonce2 = Keypair.generate();

    // Airdrop SOL for transaction fees
    const initialTestWalletBalance = await provider.connection.requestAirdrop(
      provider.publicKey,
      0.5 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(
      initialTestWalletBalance,
      "confirmed",
    );

    const initialBalance = await provider.connection.requestAirdrop(
      creator.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(initialBalance, "confirmed");

    const initialBalanceClaimant = await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(
      initialBalanceClaimant,
      "confirmed",
    );

    // Airdrop SOL to nonce accounts for rent
    const nonce1Balance = await provider.connection.requestAirdrop(
      nonce1.publicKey,
      0.1 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(nonce1Balance, "confirmed");

    const nonce2Balance = await provider.connection.requestAirdrop(
      nonce2.publicKey,
      0.1 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(nonce2Balance, "confirmed");
  });

  beforeEach(async () => {
    // Create a new mint keypair and derive PDAs (no on-chain state yet)
    mint = Keypair.generate();
    creatorAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      creator.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    );

    // Derive PDAs for airdrop 1
    [airdropPda1] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("airdrop"),
        creator.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
        nonce1.publicKey.toBuffer(),
      ],
      program.programId,
    );

    pdaAta1 = getAssociatedTokenAddressSync(
      mint.publicKey,
      airdropPda1,
      true,
      TOKEN_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    );

    [replayBitmapPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), airdropPda1.toBuffer()],
      program.programId,
    );

    // Derive PDAs for airdrop 2
    [airdropPda2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("airdrop"),
        creator.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
        nonce2.publicKey.toBuffer(),
      ],
      program.programId,
    );

    pdaAta2 = getAssociatedTokenAddressSync(
      mint.publicKey,
      airdropPda2,
      true,
      TOKEN_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    );

    [replayBitmapPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), airdropPda2.toBuffer()],
      program.programId,
    );

    // Create mint on blockchain first, then creator ATA and claimant dest ATA
    const lamports = await getMinimumBalanceForRentExemptMint(
      provider.connection,
    );
    const createMintTx = new Transaction().add(
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
        TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        creatorAta,
        creator.publicKey,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createMintToInstruction(
        mint.publicKey,
        creatorAta,
        creator.publicKey,
        (TOTAL_AMOUNT_1 + TOTAL_AMOUNT_2) * 100,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );

    createMintTx.feePayer = creator.publicKey;
    createMintTx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    createMintTx.sign(creator, mint);

    const createMintSig = await provider.connection.sendTransaction(
      createMintTx,
      [creator, mint],
    );
    await provider.connection.confirmTransaction(createMintSig, "confirmed");

    // Now mint exists on chain; create claimant's destination token account
    destAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      claimant,
      mint.publicKey,
      claimant.publicKey,
      false,
    ).then((ata) => ata.address);
  });

  // Helper function to create an airdrop with a nonce
  async function createAirdropWithNonce(
    nonce: Keypair,
    totalAmount: number,
    airdropPda: PublicKey,
    pdaAta: PublicKey,
    replayBitmapPda: PublicKey,
  ) {
    const endsAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const vouchers = 8192;

    const createAirdropIx = await program.methods
      .createAirdrop(
        new anchor.BN(totalAmount),
        new anchor.BN(endsAt),
        new anchor.BN(vouchers),
      )
      .accounts({
        creator: creator.publicKey,
        backend: backend.publicKey,
        mint: mint.publicKey,
        nonce: nonce.publicKey,
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

    return createAirdropIx;
  }

  // Helper function to create a voucher
  function createVoucher(
    airdropPda: PublicKey,
    claimant: PublicKey,
    amount: number,
    nonce: number,
    expiry: number,
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

    return new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });
  }

  // Helper function to claim tokens from a specific airdrop
  async function claimTokens(
    airdropPda: PublicKey,
    pdaAta: PublicKey,
    replayBitmapPda: PublicKey,
    amount: number,
    nonce: number,
    expiry: number,
  ) {
    const edIx = createVoucher(
      airdropPda,
      claimant.publicKey,
      amount,
      nonce,
      expiry,
    );

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

    const txSignature = await provider.connection.sendTransaction(tx, [
      claimant,
    ]);
    await provider.connection.confirmTransaction(txSignature);
    return txSignature;
  }

  it("Creates two airdrops with same creator and mint but different nonces", async () => {
    // Mint already created in beforeEach; create PDA ATAs and both airdrops
    const createAirdropIx1 = await createAirdropWithNonce(
      nonce1,
      TOTAL_AMOUNT_1,
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
    );

    const createAirdropIx2 = await createAirdropWithNonce(
      nonce2,
      TOTAL_AMOUNT_2,
      airdropPda2,
      pdaAta2,
      replayBitmapPda2,
    );

    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta1,
        airdropPda1,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta2,
        airdropPda2,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAirdropIx1,
      createAirdropIx2,
    );

    tx.feePayer = creator.publicKey;
    tx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    tx.sign(creator);

    const txSignature = await provider.connection.sendTransaction(tx, [
      creator,
    ]);
    await provider.connection.confirmTransaction(txSignature, "confirmed");

    // Verify both airdrops were created
    const airdropAccount1 = await program.account.airdrop.fetch(airdropPda1);
    expect(airdropAccount1.creator.toString()).to.equal(
      creator.publicKey.toString(),
    );
    expect(airdropAccount1.mint.toString()).to.equal(mint.publicKey.toString());
    expect(airdropAccount1.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT_1);
    expect(airdropAccount1.claimedAmount.toNumber()).to.equal(0);

    const airdropAccount2 = await program.account.airdrop.fetch(airdropPda2);
    expect(airdropAccount2.creator.toString()).to.equal(
      creator.publicKey.toString(),
    );
    expect(airdropAccount2.mint.toString()).to.equal(mint.publicKey.toString());
    expect(airdropAccount2.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT_2);
    expect(airdropAccount2.claimedAmount.toNumber()).to.equal(0);

    // Verify PDAs are different
    expect(airdropPda1.toString()).to.not.equal(airdropPda2.toString());

    // Verify tokens were transferred to both PDAs
    const pdaAtaAccount1 = await getAccount(provider.connection, pdaAta1);
    expect(Number(pdaAtaAccount1.amount)).to.equal(TOTAL_AMOUNT_1);

    const pdaAtaAccount2 = await getAccount(provider.connection, pdaAta2);
    expect(Number(pdaAtaAccount2.amount)).to.equal(TOTAL_AMOUNT_2);
  });

  it("Claims from both airdrops independently", async () => {
    // Mint already created in beforeEach; create PDA ATAs and both airdrops
    const createAirdropIx1 = await createAirdropWithNonce(
      nonce1,
      TOTAL_AMOUNT_1,
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
    );

    const createAirdropIx2 = await createAirdropWithNonce(
      nonce2,
      TOTAL_AMOUNT_2,
      airdropPda2,
      pdaAta2,
      replayBitmapPda2,
    );

    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta1,
        airdropPda1,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta2,
        airdropPda2,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAirdropIx1,
      createAirdropIx2,
    );

    setupTx.feePayer = creator.publicKey;
    setupTx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    setupTx.sign(creator);

    const setupSig = await provider.connection.sendTransaction(setupTx, [
      creator,
    ]);
    await provider.connection.confirmTransaction(setupSig, "confirmed");

    // Claim from airdrop 1
    const claimAmount1 = 100000; // 0.1 tokens
    const nonce1_claim = 1;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    await claimTokens(
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
      claimAmount1,
      nonce1_claim,
      expiry,
    );

    // Claim from airdrop 2
    const claimAmount2 = 200000; // 0.2 tokens
    const nonce2_claim = 1;

    await claimTokens(
      airdropPda2,
      pdaAta2,
      replayBitmapPda2,
      claimAmount2,
      nonce2_claim,
      expiry,
    );

    // Verify both claims were successful
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(claimAmount1 + claimAmount2);

    // Verify airdrop accounts were updated independently
    const airdropAccount1 = await program.account.airdrop.fetch(airdropPda1);
    expect(airdropAccount1.claimedAmount.toNumber()).to.equal(claimAmount1);
    expect(airdropAccount1.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT_1);

    const airdropAccount2 = await program.account.airdrop.fetch(airdropPda2);
    expect(airdropAccount2.claimedAmount.toNumber()).to.equal(claimAmount2);
    expect(airdropAccount2.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT_2);
  });

  it("Uses same nonce value in both airdrops without conflict", async () => {
    // Mint already created in beforeEach; create PDA ATAs and both airdrops
    const createAirdropIx1 = await createAirdropWithNonce(
      nonce1,
      TOTAL_AMOUNT_1,
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
    );

    const createAirdropIx2 = await createAirdropWithNonce(
      nonce2,
      TOTAL_AMOUNT_2,
      airdropPda2,
      pdaAta2,
      replayBitmapPda2,
    );

    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta1,
        airdropPda1,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta2,
        airdropPda2,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAirdropIx1,
      createAirdropIx2,
    );

    setupTx.feePayer = creator.publicKey;
    setupTx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    setupTx.sign(creator);

    const setupSig = await provider.connection.sendTransaction(setupTx, [
      creator,
    ]);
    await provider.connection.confirmTransaction(setupSig, "confirmed");

    // Use the same nonce value (42) for both airdrops
    const sharedNonce = 42;
    const claimAmount = 50000;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    // Claim from airdrop 1 with nonce 42
    await claimTokens(
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
      claimAmount,
      sharedNonce,
      expiry,
    );

    // Claim from airdrop 2 with the same nonce value (42) - should work
    await claimTokens(
      airdropPda2,
      pdaAta2,
      replayBitmapPda2,
      claimAmount,
      sharedNonce,
      expiry,
    );

    // Verify both claims succeeded
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(claimAmount * 2);

    // Verify both airdrops track their claims independently
    const airdropAccount1 = await program.account.airdrop.fetch(airdropPda1);
    expect(airdropAccount1.claimedAmount.toNumber()).to.equal(claimAmount);

    const airdropAccount2 = await program.account.airdrop.fetch(airdropPda2);
    expect(airdropAccount2.claimedAmount.toNumber()).to.equal(claimAmount);
  });

  it("Prevents replay attacks independently per airdrop", async () => {
    // Mint already created in beforeEach; create PDA ATAs and both airdrops
    const createAirdropIx1 = await createAirdropWithNonce(
      nonce1,
      TOTAL_AMOUNT_1,
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
    );

    const createAirdropIx2 = await createAirdropWithNonce(
      nonce2,
      TOTAL_AMOUNT_2,
      airdropPda2,
      pdaAta2,
      replayBitmapPda2,
    );

    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta1,
        airdropPda1,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta2,
        airdropPda2,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAirdropIx1,
      createAirdropIx2,
    );

    setupTx.feePayer = creator.publicKey;
    setupTx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    setupTx.sign(creator);

    const setupSig = await provider.connection.sendTransaction(setupTx, [
      creator,
    ]);
    await provider.connection.confirmTransaction(setupSig, "confirmed");

    const claimAmount = 100000;
    const sharedNonce = 100;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    // First claim from airdrop 1
    await claimTokens(
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
      claimAmount,
      sharedNonce,
      expiry,
    );

    // Try to replay the same nonce on airdrop 1 - should fail
    const edIx = createVoucher(
      airdropPda1,
      claimant.publicKey,
      claimAmount,
      sharedNonce,
      expiry,
    );

    const claimIx = await program.methods
      .claim(
        new anchor.BN(claimAmount),
        new anchor.BN(sharedNonce),
        new anchor.BN(expiry),
      )
      .accounts({
        airdrop: airdropPda1,
        pdaAta: pdaAta1,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda1,
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
      expect.fail("Transaction should have failed - replay attack");
    } catch (error: any) {
      expect(error.message).to.include("VoucherAlreadyUsed");
    }

    // But the same nonce should still work for airdrop 2 (different bitmap)
    await claimTokens(
      airdropPda2,
      pdaAta2,
      replayBitmapPda2,
      claimAmount,
      sharedNonce,
      expiry,
    );

    // Verify airdrop 2 claim succeeded
    const airdropAccount2 = await program.account.airdrop.fetch(airdropPda2);
    expect(airdropAccount2.claimedAmount.toNumber()).to.equal(claimAmount);
  });

  it("Allows different backends for different airdrops", async () => {
    // Mint already created in beforeEach; create PDA ATAs and both airdrops with different backends
    const backend2 = Keypair.generate();

    // Create airdrop 1 with backend
    const createAirdropIx1 = await program.methods
      .createAirdrop(
        new anchor.BN(TOTAL_AMOUNT_1),
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
        new anchor.BN(8192),
      )
      .accounts({
        creator: creator.publicKey,
        backend: backend.publicKey,
        mint: mint.publicKey,
        nonce: nonce1.publicKey,
        creatorAta: creatorAta,
        airdrop: airdropPda1,
        pdaAta: pdaAta1,
        replayBitmap: replayBitmapPda1,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    // Create airdrop 2 with backend2
    const createAirdropIx2 = await program.methods
      .createAirdrop(
        new anchor.BN(TOTAL_AMOUNT_2),
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
        new anchor.BN(8192),
      )
      .accounts({
        creator: creator.publicKey,
        backend: backend2.publicKey,
        mint: mint.publicKey,
        nonce: nonce2.publicKey,
        creatorAta: creatorAta,
        airdrop: airdropPda2,
        pdaAta: pdaAta2,
        replayBitmap: replayBitmapPda2,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta1,
        airdropPda1,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        creator.publicKey,
        pdaAta2,
        airdropPda2,
        mint.publicKey,
        TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      ),
      createAirdropIx1,
      createAirdropIx2,
    );

    setupTx.feePayer = creator.publicKey;
    setupTx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    setupTx.sign(creator);

    const setupSig = await provider.connection.sendTransaction(setupTx, [
      creator,
    ]);
    await provider.connection.confirmTransaction(setupSig, "confirmed");

    // Verify backends are different
    const airdropAccount1 = await program.account.airdrop.fetch(airdropPda1);
    const airdropAccount2 = await program.account.airdrop.fetch(airdropPda2);

    expect(airdropAccount1.backend.toString()).to.equal(
      backend.publicKey.toString(),
    );
    expect(airdropAccount2.backend.toString()).to.equal(
      backend2.publicKey.toString(),
    );

    // Claim from airdrop 1 with backend signature
    const claimAmount = 100000;
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    await claimTokens(
      airdropPda1,
      pdaAta1,
      replayBitmapPda1,
      claimAmount,
      nonce,
      expiry,
    );

    // Claim from airdrop 2 with backend2 signature
    const edIx2 = createVoucher(
      airdropPda2,
      claimant.publicKey,
      claimAmount,
      nonce,
      expiry,
    );
    // But sign with backend2 instead
    const airdropPdaBuf2 = airdropPda2.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(claimAmount), 0);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(expiry), 0);
    const message2 = Buffer.concat([
      airdropPdaBuf2,
      claimantBuf,
      amountBuf,
      nonceBuf,
      expiryBuf,
    ]);
    const voucherSignature2 = nacl.sign.detached(message2, backend2.secretKey);

    const headerSize = 16;
    const signatureLength = 64;
    const pubkeyLength = 32;
    const messageLength = message2.length;

    const signatureOffset = headerSize;
    const pubkeyOffset = signatureOffset + signatureLength;
    const messageOffset = pubkeyOffset + pubkeyLength;

    const edIxData2 = Buffer.alloc(
      headerSize + signatureLength + pubkeyLength + messageLength,
    );

    edIxData2[0] = 1;
    edIxData2[1] = 0;
    edIxData2.writeUInt16LE(signatureOffset, 2);
    edIxData2.writeUInt16LE(0, 4);
    edIxData2.writeUInt16LE(pubkeyOffset, 6);
    edIxData2.writeUInt16LE(0, 8);
    edIxData2.writeUInt16LE(messageOffset, 10);
    edIxData2.writeUInt16LE(messageLength, 12);
    edIxData2.writeUInt16LE(0, 14);

    edIxData2.set(voucherSignature2, signatureOffset);
    edIxData2.set(backend2.publicKey.toBuffer(), pubkeyOffset);
    edIxData2.set(message2, messageOffset);

    const edIx2_final = new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData2,
    });

    const claimIx2 = await program.methods
      .claim(
        new anchor.BN(claimAmount),
        new anchor.BN(nonce),
        new anchor.BN(expiry),
      )
      .accounts({
        airdrop: airdropPda2,
        pdaAta: pdaAta2,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda2,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx2 = new Transaction().add(edIx2_final).add(claimIx2);
    tx2.feePayer = claimant.publicKey;
    const { blockhash: blockhash2 } =
      await provider.connection.getLatestBlockhash();
    tx2.recentBlockhash = blockhash2;
    tx2.sign(claimant);

    const txSignature2 = await provider.connection.sendTransaction(tx2, [
      claimant,
    ]);
    await provider.connection.confirmTransaction(txSignature2);

    // Verify both claims succeeded
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(claimAmount * 2);
  });
});

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Ed25519Program } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { expect } from "chai";
import "./test-setup";

describe("Replay Bitmap", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider();

  let creator: Keypair;
  let backend: Keypair;
  let claimant: Keypair;
  let mint: PublicKey;
  let airdropPda: PublicKey;
  let pdaAta: PublicKey;
  let destAta: PublicKey;
  let replayBitmapPda: PublicKey;

  const TOTAL_AMOUNT = 1000000;
  const CLAIM_AMOUNT = 10000;
  const MINT_DECIMALS = 6;

  before(async () => {
    creator = Keypair.generate();
    backend = Keypair.generate();
    claimant = Keypair.generate();
 
     // check test wallet balance
     const initialTestWalletBalance = await provider.connection.requestAirdrop(
       provider.publicKey,
       20 * anchor.web3.LAMPORTS_PER_SOL
     );
 
     await provider.connection.confirmTransaction(
       initialTestWalletBalance,
       "confirmed"
     );
 
     const initialBalance = await provider.connection.requestAirdrop(
       creator.publicKey,
       20 * anchor.web3.LAMPORTS_PER_SOL
     );
 
     await provider.connection.confirmTransaction(initialBalance, "confirmed");
 
     const initialBalanceClaimant = await provider.connection.requestAirdrop(
       claimant.publicKey,
       20 * anchor.web3.LAMPORTS_PER_SOL
     );
 
     await provider.connection.confirmTransaction(
       initialBalanceClaimant,
       "confirmed"
     );
 
     // Create a test mint
     mint = await createMint(
       provider.connection,
       creator,
       creator.publicKey,
       null,
       MINT_DECIMALS
     );
 
     const creatorAta = await createAccount(
       provider.connection,
       creator,
       mint,
       creator.publicKey
     );
 
     // Mint tokens to creator
     const tokenBalance = await mintTo(
       provider.connection,
       creator,
       mint,
       creatorAta,
       creator,
       TOTAL_AMOUNT * 2 // Mint extra for testing
     );
 
     await provider.connection.confirmTransaction(tokenBalance, "confirmed");
 
     [airdropPda] = PublicKey.findProgramAddressSync(
       [Buffer.from("airdrop"), creator.publicKey.toBuffer(), mint.toBuffer()],
       program.programId
     );
 
     pdaAta = await getOrCreateAssociatedTokenAccount(
       provider.connection,
       creator,
       mint,
       airdropPda,
       true
     ).then((ata) => ata.address);
 
     destAta = await getOrCreateAssociatedTokenAccount(
       provider.connection,
       claimant,
       mint,
       claimant.publicKey,
       false
     ).then((ata) => ata.address);
 
     [replayBitmapPda] = PublicKey.findProgramAddressSync(
       [Buffer.from("bitmap"), airdropPda.toBuffer()],
       program.programId
     );
    // Create airdrop
    await program.methods
      .createAirdrop(
        new anchor.BN(TOTAL_AMOUNT),
        new anchor.BN(CLAIM_AMOUNT),
        null // No expiration
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
  });

  it("Initializes replay bitmap correctly", async () => {
    const bitmapAccount = await program.account.replayBitmap.fetch(
      replayBitmapPda
    );

    expect(bitmapAccount.sizeBits).to.equal(8192);
    expect(bitmapAccount.bits.length).to.equal(1024); // 8192 / 8 = 1024 bytes

    // All bits should be 0 initially
    const allZeros = bitmapAccount.bits.every((byte) => byte === 0);
    expect(allZeros).to.be.true;
  });

  it("Sets and checks individual bits correctly", async () => {
    const testNonces = [
      1, 9, 10, 17, 18, 33, 34, 65, 66, 129, 130, 257, 258, 513, 514, 1025,
      1024, 2047, 2048, 4093, 4094, 8190,
    ];

    for (const nonce of testNonces) {
      const expiry = Math.floor(Date.now() / 1000) + 3600;

      const airdropPdaBuf = airdropPda.toBuffer();
      const claimantBuf = claimant.publicKey.toBuffer();
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
  
      const edIx = new anchor.web3.TransactionInstruction({
        programId: Ed25519Program.programId,
        keys: [],
        data: edIxData,
      });
  
      const claimIx = await program.methods
        .claim(new anchor.BN(nonce), new anchor.BN(expiry))
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
  
      // Create and send transaction
      const tx = new Transaction().add(edIx).add(claimIx);
      tx.feePayer = claimant.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.sign(claimant);

      const txSignature = await provider.connection.sendTransaction(tx, [
        claimant,
      ]);
      await provider.connection.confirmTransaction(txSignature);

      console.log(`Successfully claimed with nonce ${nonce}:`, txSignature);
    }

    // Verify bitmap was updated
    const bitmapAccount = await program.account.replayBitmap.fetch(
      replayBitmapPda
    );

    // Check that specific bits are set
    for (const nonce of testNonces) {
      const byteIndex = Math.floor(nonce / 8);
      const bitIndex = nonce % 8;
      const mask = 1 << bitIndex;

      expect(bitmapAccount.bits[byteIndex] & mask).to.equal(
        mask,
        `Bit for nonce ${nonce} should be set`
      );
    }
  });

  it("Prevents replay attacks with same nonce", async () => {
    const nonce = 2100;
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    // First claim should succeed
    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
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

    const signature = nacl.sign.detached(message, backend.secretKey);

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

    edIxData.set(signature, signatureOffset);
    edIxData.set(backend.publicKey.toBuffer(), pubkeyOffset);
    edIxData.set(message, messageOffset);

    const edIx = new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });

    const claimIx = await program.methods
      .claim(new anchor.BN(nonce), new anchor.BN(expiry))
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

    // Create and send transaction
    const tx = new Transaction().add(edIx).add(claimIx);
    tx.feePayer = claimant.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    const txSignature = await provider.connection.sendTransaction(tx, [
      claimant,
    ]);
    await provider.connection.confirmTransaction(txSignature);

    console.log("First claim successful:", txSignature);

    // Second claim with same nonce should fail
    const tx2 = new Transaction().add(edIx).add(claimIx);
    tx2.feePayer = claimant.publicKey;
    const { blockhash: blockhash2 } =
      await provider.connection.getLatestBlockhash();
    tx2.recentBlockhash = blockhash2;
    tx2.sign(claimant);

    try {
      await provider.connection.sendTransaction(tx2, [claimant]);
      expect.fail("Second claim should have failed");
    } catch (error) {
      expect(error.message).to.include("VoucherAlreadyUsed");
    }
  });

  it("Tests bitmap boundary conditions", async () => {
    // Test nonce 0 (first bit)
    await testNonceClaim(0);

    // Test nonce 8191 (last bit)
    await testNonceClaim(8191);

    // Test nonce 4095 (middle bit)
    await testNonceClaim(4095);

    // Test nonce 4096 (first bit of second half)
    await testNonceClaim(4096);
  });

  it("Tests byte boundary conditions", async () => {
    // Test nonces that cross byte boundaries
    const boundaryNonces = [
      7, 8, 15, 16, 23, 24, 31, 32, 39, 40, 47, 48, 55, 56, 63, 64,
    ];

    for (const nonce of boundaryNonces) {
      await testNonceClaim(nonce);
    }
  });

  it("Verifies bitmap persistence across multiple claims", async () => {
    const initialBitmap = await program.account.replayBitmap.fetch(
      replayBitmapPda
    );
    const initialBits = [...initialBitmap.bits];

    // Make several claims
    const nonces = [1000, 2000, 3000, 4000, 5000];

    for (const nonce of nonces) {
      await testNonceClaim(nonce);
    }

    // Verify bitmap was updated
    const finalBitmap = await program.account.replayBitmap.fetch(
      replayBitmapPda
    );

    // Check that new bits were set
    for (const nonce of nonces) {
      const byteIndex = Math.floor(nonce / 8);
      const bitIndex = nonce % 8;
      const mask = 1 << bitIndex;

      expect(finalBitmap.bits[byteIndex] & mask).to.equal(
        mask,
        `Bit for nonce ${nonce} should be set`
      );
    }

    // Verify that previously set bits are still set
    for (let i = 0; i < initialBits.length; i++) {
      const expectedBits = initialBits[i] | finalBitmap.bits[i];
      expect(finalBitmap.bits[i]).to.equal(
        expectedBits,
        `Byte ${i} should preserve previous bits`
      );
    }
  });

  async function testNonceClaim(nonce: number): Promise<void> {
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
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

    const edIx = new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });

    const claimIx = await program.methods
      .claim(new anchor.BN(nonce), new anchor.BN(expiry))
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

    // Create and send transaction
    const tx = new Transaction().add(edIx).add(claimIx);
    tx.feePayer = claimant.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(claimant);

    const txSignature = await provider.connection.sendTransaction(tx, [
      claimant,
    ]);
    await provider.connection.confirmTransaction(txSignature);

    console.log(`Successfully claimed with nonce ${nonce}:`, txSignature);
  }
});

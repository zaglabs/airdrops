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
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Ed25519Program } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { expect } from "chai";
import "./test-setup";

describe("Voucher System", () => {
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

  it("Creates valid ed25519 voucher message", () => {
    const nonce = 123;
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    // Build canonical message: airdropPda || claimantPubkey || nonce_le || expiry_le
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

    // Verify message structure
    expect(message.length).to.equal(80); // 32 + 32 + 8 + 8
    expect(message.slice(0, 32)).to.deep.equal(airdropPdaBuf);
    expect(message.slice(32, 64)).to.deep.equal(claimantBuf);
    expect(message.slice(64, 72)).to.deep.equal(nonceBuf);
    expect(message.slice(72, 80)).to.deep.equal(expiryBuf);
  });

  it("Signs and verifies ed25519 voucher", () => {
    const nonce = 456;
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

    // Sign with backend
    const voucherSignature = nacl.sign.detached(message, backend.secretKey);

    // Verify signature
    const isValid = nacl.sign.detached.verify(
      message,
      voucherSignature,
      backend.publicKey.toBuffer()
    );

    expect(isValid).to.be.true;
  });

  it("Rejects voucher with wrong message", () => {
    const nonce = 789;
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    // Create correct message
    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(expiry), 0);
    const correctMessage = Buffer.concat([
      airdropPdaBuf,
      claimantBuf,
      nonceBuf,
      expiryBuf,
    ]);

    // Create wrong message (different nonce)
    const wrongNonceBuf = Buffer.alloc(8);
    wrongNonceBuf.writeBigUInt64LE(BigInt(999), 0);
    const wrongMessage = Buffer.concat([
      airdropPdaBuf,
      claimantBuf,
      wrongNonceBuf,
      expiryBuf,
    ]);

    // Sign correct message
    const voucherSignature = nacl.sign.detached(
      correctMessage,
      backend.secretKey
    );

    // Try to verify with wrong message
    const isValid = nacl.sign.detached.verify(
      wrongMessage,
      voucherSignature,
      backend.publicKey.toBuffer()
    );

    expect(isValid).to.be.false;
  });

  it("Rejects voucher with wrong signer", () => {
    const nonce = 101;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const wrongBackend = Keypair.generate();

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

    // Sign with wrong backend
    const voucherSignature = nacl.sign.detached(
      message,
      wrongBackend.secretKey
    );

    // Try to verify with correct backend
    const isValid = nacl.sign.detached.verify(
      message,
      voucherSignature,
      backend.publicKey.toBuffer()
    );

    expect(isValid).to.be.false;
  });

  it("Handles multiple vouchers with different nonces", async () => {
    const nonces = [200, 201, 202];
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    for (const nonce of nonces) {
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

    // Verify final balances
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(
      CLAIM_AMOUNT * nonces.length
    ); // +1 for previous test

    const airdropAccount = await program.account.airdrop.fetch(
      airdropPda
    );
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(
      CLAIM_AMOUNT * nonces.length
    );
  });

  it("Tests edge cases for nonce values", async () => {
    const edgeCases = [0, 1, 8191, 4096]; // Test boundaries and middle values
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    for (const nonce of edgeCases) {
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

      console.log(
        `Successfully claimed with edge case nonce ${nonce}:`,
        txSignature
      );
    }
  });

  it("Fails with nonce out of range", async () => {
    const nonce = 8192; // Out of range (max is 8191)
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

    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed");
    } catch (error) {
      expect(error.message).to.include("NonceOutOfRange");
    }
  });
});

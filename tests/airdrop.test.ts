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
  createAccount,
  mintTo,
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

describe("airdrop", () => {
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
  const TOTAL_AMOUNT = 1000000; // 1 tokens
  const CLAIM_AMOUNT = 10000; // 0.01 tokens per claim
  const MINT_DECIMALS = 6;

  before(async () => {
    // Generate test keypairs
    creator = Keypair.generate();
    backend = Keypair.generate();
    claimant = Keypair.generate();

    // check test wallet balance
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

  it("Creates an airdrop successfully", async () => {
    const endsAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const vouchers = 8192;

    //combine create token, mintTo and create airdrop into one transaction
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

    const createAirdropIx = await program.methods
      .createAirdrop(
        new anchor.BN(TOTAL_AMOUNT),
        new anchor.BN(CLAIM_AMOUNT),
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

    // Verify airdrop account was created
    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.creator.toString()).to.equal(
      creator.publicKey.toString()
    );
    expect(airdropAccount.mint.toString()).to.equal(mint.publicKey.toString());
    expect(airdropAccount.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT);
    expect(airdropAccount.claimAmount.toNumber()).to.equal(CLAIM_AMOUNT);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(0);
    expect(airdropAccount.backend.toString()).to.equal(
      backend.publicKey.toString()
    );

    // Verify tokens were transferred to PDA
    const pdaAtaAccount = await getAccount(provider.connection, pdaAta);
    expect(Number(pdaAtaAccount.amount)).to.equal(TOTAL_AMOUNT);
  });

  it("Claims tokens with valid ed25519 voucher", async () => {
    const nonce = 42;
    const expiry = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

    // Build the canonical message that backend should sign
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

    // Backend signs the message
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

    const txSignature = await provider.connection.sendTransaction(tx, [claimant]);
    await provider.connection.confirmTransaction(txSignature);

    // Verify tokens were transferred
    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(CLAIM_AMOUNT);

    // Verify airdrop account was updated
    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(CLAIM_AMOUNT);

    // Verify replay bitmap was updated
    const bitmapAccount = await program.account.replayBitmap.fetch(
      replayBitmapPda
    );
    expect(bitmapAccount.sizeBits).to.equal(8192);
  });

  it("Fails to claim with invalid voucher", async () => {
    const nonce = 43;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    // Create a message with wrong backend key
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
    edIxData.set(wrongBackend.publicKey.toBuffer(), pubkeyOffset);
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

    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed");
    } catch (error) {
      expect(error.message).to.include("InvalidVoucher");
    }
  });

  it("Fails to claim with expired voucher", async () => {
    const nonce = 44;
    const expiry = Math.floor(Date.now() / 1000) - (1 * 100000000000); // 5 minutes ago (expired) ??

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

    try {
      await provider.connection.sendTransaction(tx, [claimant])
      expect.fail("Transaction should have failed");
    } catch (error) {
      expect(error.message).to.include("VoucherExpired");
    }
  });

  it("Fails to claim with reused nonce (replay attack)", async () => {
    const nonce = 42; // Same nonce as first successful claim
    const expiry = Math.floor(Date.now() / 1000) + 300;

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

    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed");
    } catch (error) {
      expect(error.message).to.include("VoucherAlreadyUsed");
    }
  });

  it("Allows creator to withdraw remaining tokens", async () => {
    const initialCreatorBalance = await getAccount(
      provider.connection,
      creatorAta
    );
    const initialBalance = Number(initialCreatorBalance.amount);

    const tx = await program.methods
      .withdraw()
      .accounts({
        airdrop: airdropPda,
        creator: creator.publicKey,
        pdaAta: pdaAta,
        creatorAta: creatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();

    // Verify tokens were returned to creator
    const finalCreatorBalance = await getAccount(
      provider.connection,
      creatorAta
    );
    const finalBalance = Number(finalCreatorBalance.amount);

    // Should have received back the unclaimed amount (TOTAL_AMOUNT - CLAIM_AMOUNT)
    expect(finalBalance).to.equal(
      initialBalance + (TOTAL_AMOUNT - CLAIM_AMOUNT)
    );
  });

  it("Fails when non-creator tries to withdraw", async () => {
    const nonCreator = Keypair.generate();

    // Airdrop SOL to non-creator for transaction fees
    await provider.connection.requestAirdrop(
      nonCreator.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );

    try {
      await program.methods
        .withdraw()
        .accounts({
          airdrop: airdropPda,
          creator: nonCreator.publicKey,
          pdaAta: pdaAta,
          creatorAta: creatorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([nonCreator])
        .rpc();
      expect.fail("Transaction should have failed");
    } catch (error) {
      expect(error.message).to.include("ConstraintHasOne");
    }
  });

  it("Fails to claim when airdrop is expired", async () => {
    // Create a new airdrop with immediate expiration
    const expiredAirdropCreator = Keypair.generate();

    // Airdrop SOL to creator
    const initialBalanceCreator = await provider.connection.requestAirdrop(
      expiredAirdropCreator.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );

    await provider.connection.confirmTransaction(
      initialBalanceCreator,
      "confirmed"
    );

    const expiredAirdropPda = PublicKey.findProgramAddressSync(
      [Buffer.from("airdrop"), expiredAirdropCreator.publicKey.toBuffer(), mint.publicKey.toBuffer()],
      program.programId
    )[0];

    const expiredAirdropPdaAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      mint.publicKey,
      expiredAirdropPda,
      true
    ).then((ata) => ata.address);

    const expiredReplayBitmapPda = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), expiredAirdropPda.toBuffer()],
      program.programId
    )[0];
    
    const expiredCreatorAta = await createAccount(
      provider.connection,
      expiredAirdropCreator,
      mint.publicKey,
      expiredAirdropCreator.publicKey
    );

    // Mint tokens to creator
    await mintTo(
      provider.connection,
      creator,
      mint.publicKey,
      expiredCreatorAta,
      creator,
      TOTAL_AMOUNT
    );

    // Create expired airdrop
    const pastTime = Math.floor(Date.now() / 1000) - (1 * 100000000000); // 1 hour ago
    await program.methods
      .createAirdrop(
        new anchor.BN(TOTAL_AMOUNT),
        new anchor.BN(CLAIM_AMOUNT),
        new anchor.BN(pastTime),
        new anchor.BN(8192)
      )
      .accounts({
        creator: expiredAirdropCreator.publicKey,
        backend: backend.publicKey,
        mint: mint.publicKey,
        airdrop: expiredAirdropPda,
        pdaAta: expiredAirdropPdaAta,
        creatorAta: expiredCreatorAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([expiredAirdropCreator])
      .rpc();

    // Try to claim from expired airdrop
    const nonce = 100;
    const expiry = Math.floor(Date.now() / 1000) + 10000000;

    const airdropPdaBuf = expiredAirdropPda.toBuffer();
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
        airdrop: expiredAirdropPda,
        pdaAta: expiredAirdropPdaAta,
        destAta: destAta,
        claimant: claimant.publicKey,
        replayBitmap: expiredReplayBitmapPda,
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
    } catch (error) {
      expect(error.message).to.include("AirdropExpired");
    }
  });
});

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
import { confirmTransaction } from "./test-utils";
import "./test-setup";

function getInstancePda(programId: PublicKey, feeRecipient: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("instance"), feeRecipient.toBuffer()],
    programId,
  );
  return pda;
}

describe("airdrop", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider();

  // Test accounts
  let creator: Keypair;
  let backend: Keypair;
  let claimant: Keypair;
  let mint: Keypair;
  let nonce: Keypair;
  let creatorAta: PublicKey;
  let airdropPda: PublicKey;
  let pdaAta: PublicKey;
  let destAta: PublicKey;
  let replayBitmapPda: PublicKey;
  let instanceConfigPda: PublicKey;
  // Test constants
  const TOTAL_AMOUNT = 1000000; // 1 token (6 decimals)
  const CLAIM_AMOUNT = 10000; // 0.01 tokens per claim
  const MINT_DECIMALS = 6;
  const VOUCHERS = 8192;

  before(async () => {
    creator = Keypair.generate();
    backend = Keypair.generate();
    claimant = Keypair.generate();
    nonce = Keypair.generate();

    const initialTestWalletBalance = await provider.connection.requestAirdrop(
      provider.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await confirmTransaction(provider.connection, initialTestWalletBalance);

    const initialBalance = await provider.connection.requestAirdrop(
      creator.publicKey,
      0.5 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await confirmTransaction(provider.connection, initialBalance);

    const initialBalanceClaimant = await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await confirmTransaction(provider.connection, initialBalanceClaimant);

    const initialBalanceNonce = await provider.connection.requestAirdrop(
      nonce.publicKey,
      0.1 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await confirmTransaction(provider.connection, initialBalanceNonce);

    // Create one fee instance (0 fee) so create_airdrop can use it. Provider = INSTANCE_AUTHORITY.
    instanceConfigPda = getInstancePda(program.programId, provider.publicKey);
    const instanceInfo = await provider.connection.getAccountInfo(instanceConfigPda);
    if (!instanceInfo) {
      await program.methods
        .createInstance(new anchor.BN(0))
        .accounts({
          authority: provider.publicKey,
          admin: provider.publicKey,
          feeRecipient: provider.publicKey,
          instanceConfig: instanceConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  it("Creates an airdrop successfully", async () => {
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
      [
        Buffer.from("airdrop"),
        creator.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
        nonce.publicKey.toBuffer(),
      ],
      program.programId,
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
      program.programId,
    );

    const createAirdropIx = await program.methods
      .createAirdrop(new anchor.BN(TOTAL_AMOUNT), new anchor.BN(VOUCHERS))
      .accounts({
        creator: creator.publicKey,
        backend: backend.publicKey,
        mint: mint.publicKey,
        nonce: nonce.publicKey,
        instanceConfig: instanceConfigPda,
        feeRecipient: provider.publicKey,
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
      createAirdropIx,
    );

    tx.feePayer = creator.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(creator, mint);

    const txSignature = await provider.connection.sendTransaction(tx, [creator, mint]);
    await confirmTransaction(provider.connection, txSignature);

    destAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      claimant,
      mint.publicKey,
      claimant.publicKey,
      false,
    ).then((ata) => ata.address);

    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.creator.toString()).to.equal(creator.publicKey.toString());
    expect(airdropAccount.mint.toString()).to.equal(mint.publicKey.toString());
    expect(airdropAccount.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(0);
    expect(airdropAccount.backend.toString()).to.equal(backend.publicKey.toString());

    const pdaAtaAccount = await getAccount(provider.connection, pdaAta);
    expect(Number(pdaAtaAccount.amount)).to.equal(TOTAL_AMOUNT);
  });

  it("Claims tokens with valid ed25519 voucher", async () => {
    const nonceVal = 42;
    const expiry = Math.floor(Date.now() / 1000) + 300;

    // Canonical message: airdrop_pda (32) || claimant (32) || amount (u64) || nonce (u64) || expiry (i64)
    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(CLAIM_AMOUNT), 0);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonceVal), 0);
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

    const edIx = new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });

    const claimIx = await program.methods
      .claim(new anchor.BN(CLAIM_AMOUNT), new anchor.BN(nonceVal), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        creator: creator.publicKey,
        mint: mint.publicKey,
        pdaAta,
        destAta,
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
    await confirmTransaction(provider.connection, txSignature);

    const destAtaAccount = await getAccount(provider.connection, destAta);
    expect(Number(destAtaAccount.amount)).to.equal(CLAIM_AMOUNT);

    const airdropAccount = await program.account.airdrop.fetch(airdropPda);
    expect(airdropAccount.claimedAmount.toNumber()).to.equal(CLAIM_AMOUNT);

    const bitmapAccount = await program.account.replayBitmap.fetch(replayBitmapPda);
    expect(bitmapAccount.sizeBits).to.equal(VOUCHERS);
  });

  it("Fails to claim with invalid voucher", async () => {
    const nonceVal = 43;
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const wrongBackend = Keypair.generate();
    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(CLAIM_AMOUNT), 0);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonceVal), 0);
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigInt64LE(BigInt(expiry), 0);
    const message = Buffer.concat([
      airdropPdaBuf,
      claimantBuf,
      amountBuf,
      nonceBuf,
      expiryBuf,
    ]);
    const voucherSignature = nacl.sign.detached(message, wrongBackend.secretKey);

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
      .claim(new anchor.BN(CLAIM_AMOUNT), new anchor.BN(nonceVal), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        creator: creator.publicKey,
        mint: mint.publicKey,
        pdaAta,
        destAta,
        claimant: claimant.publicKey,
        replayBitmap: replayBitmapPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(edIx).add(claimIx);
    try {
      await provider.connection.sendTransaction(tx, [claimant]);
      expect.fail("Transaction should have failed");
    } catch (error: unknown) {
      expect((error as Error).message).to.include("InvalidVoucher");
    }
  });

  it("Fails to claim with expired voucher", async () => {
    const nonceVal = 44;
    const expiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(CLAIM_AMOUNT), 0);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonceVal), 0);
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

    const edIx = new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });

    const claimIx = await program.methods
      .claim(new anchor.BN(CLAIM_AMOUNT), new anchor.BN(nonceVal), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        creator: creator.publicKey,
        mint: mint.publicKey,
        pdaAta,
        destAta,
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
    } catch (error: unknown) {
      expect((error as Error).message).to.include("VoucherExpired");
    }
  });

  it("Fails to claim with reused nonce (replay attack)", async () => {
    const nonceVal = 42; // Same nonce as first successful claim
    const expiry = Math.floor(Date.now() / 1000) + 300;

    const airdropPdaBuf = airdropPda.toBuffer();
    const claimantBuf = claimant.publicKey.toBuffer();
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(CLAIM_AMOUNT), 0);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonceVal), 0);
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

    const edIx = new anchor.web3.TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: edIxData,
    });

    const claimIx = await program.methods
      .claim(new anchor.BN(CLAIM_AMOUNT), new anchor.BN(nonceVal), new anchor.BN(expiry))
      .accounts({
        airdrop: airdropPda,
        creator: creator.publicKey,
        mint: mint.publicKey,
        pdaAta,
        destAta,
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
    } catch (error: unknown) {
      expect((error as Error).message).to.include("VoucherAlreadyUsed");
    }
  });

  it("Allows instance admin to withdraw remaining tokens", async () => {
    const initialCreatorBalance = await getAccount(provider.connection, creatorAta);
    const initialBalance = Number(initialCreatorBalance.amount);
    const withdrawAmount = TOTAL_AMOUNT - CLAIM_AMOUNT;

    await program.methods
      .withdraw(new anchor.BN(withdrawAmount))
      .accounts({
        airdrop: airdropPda,
        mint: mint.publicKey,
        instanceConfig: instanceConfigPda,
        authority: provider.publicKey,
        creator: creator.publicKey,
        pdaAta,
        creatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const finalCreatorBalance = await getAccount(provider.connection, creatorAta);
    expect(Number(finalCreatorBalance.amount)).to.equal(
      initialBalance + withdrawAmount,
    );
  });

  it("Fails when non-admin tries to withdraw", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(1000))
        .accounts({
          airdrop: airdropPda,
          mint: mint.publicKey,
          instanceConfig: instanceConfigPda,
          authority: claimant.publicKey,
          creator: creator.publicKey,
          pdaAta,
          creatorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([claimant])
        .rpc();
      expect.fail("Transaction should have failed");
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.match(/Unauthorized|constraint|0x1771/);
    }
  });

});

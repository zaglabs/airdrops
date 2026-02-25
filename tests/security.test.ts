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
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  freezeAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Ed25519Program } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { expect } from "chai";
import "./test-setup";

describe("Airdrop Security Tests", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider();

  let creator: Keypair;
  let backend: Keypair;
  let claimant: Keypair;
  let attacker: Keypair;
  let mint: PublicKey;
  let creatorAta: PublicKey;
  let airdropPda: PublicKey;
  let pdaAta: PublicKey;
  let destAta: PublicKey;
  let replayBitmapPda: PublicKey;

  const TOTAL_AMOUNT = 1000000;
  const CLAIM_AMOUNT = 10000;
  const MINT_DECIMALS = 6;

  before(async () => {
    // Generate test keypairs
    creator = Keypair.generate();
    backend = Keypair.generate();
    claimant = Keypair.generate();
    attacker = Keypair.generate();

    // Fund accounts
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
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(
      initialBalance,
      "confirmed"
    );
    const claimantBalance = await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(
      claimantBalance,
      "confirmed"
    );
    const initialBalanceAttacker = await provider.connection.requestAirdrop(
      attacker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(
      initialBalanceAttacker,
      "confirmed"
    );
    // Create test mint
    mint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      MINT_DECIMALS
    );

    // Create creator's token account
    creatorAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      mint,
      creator.publicKey,
      true
    ).then((ata) => ata.address);

    // Mint tokens to creator
    await mintTo(
      provider.connection,
      creator,
      mint,
      creatorAta,
      creator,
      TOTAL_AMOUNT * 2
    );

    // Derive PDAs
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
      true
    ).then((ata) => ata.address);

    [replayBitmapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), airdropPda.toBuffer()],
      program.programId
    );
  });

  describe("Voucher Security Tests", () => {
    it("Prevents signature malleability attacks", async () => {
      // Create airdrop
      await program.methods
        .createAirdrop(
          new anchor.BN(TOTAL_AMOUNT),
          new anchor.BN(CLAIM_AMOUNT),
          null,
          new anchor.BN(8192)
        )
        .accounts({
          creator: creator.publicKey,
          backend: backend.publicKey,
          mint: mint,
          airdrop: airdropPda,
          pdaAta: pdaAta,
          creatorAta: creatorAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([creator])
        .rpc();

      const nonce = 92;
      const expiry = Math.floor(Date.now() / 1000) + 1241244;

      // Create valid voucher
      const message = Buffer.concat([
        airdropPda.toBuffer(),
        claimant.publicKey.toBuffer(),
        Buffer.from(nonce.toString().padStart(8, '0')),
        Buffer.from(expiry.toString().padStart(8, '0')),
      ]);

      const validSignature = nacl.sign.detached(message, backend.secretKey);
      validSignature[0] = validSignature[0] ^ 1;

      try {
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

        edIxData.set(validSignature, signatureOffset);
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

        const tx = new Transaction().add(edIx).add(claimIx);
        tx.feePayer = claimant.publicKey;
        const { blockhash } = await provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(claimant);

        await provider.connection.sendTransaction(tx, [claimant]);
        expect.fail("Modified signature should have been rejected");
      } catch (error) {
        expect(error.message).to.include("0x2");
      }
    });

    it("Prevents message tampering attacks", async () => {
      const nonce = 101;
      const expiry = Math.floor(Date.now() / 1000) + 3600;

      // Create valid message
      const validMessage = Buffer.concat([
        airdropPda.toBuffer(),
        claimant.publicKey.toBuffer(),
        Buffer.from(nonce.toString().padStart(8, '0')),
        Buffer.from(expiry.toString().padStart(8, '0')),
      ]);

      // Create tampered message (different nonce)
      const tamperedMessage = Buffer.concat([
        airdropPda.toBuffer(),
        claimant.publicKey.toBuffer(),
        Buffer.from((nonce + 1).toString().padStart(8, '0')), // Different nonce
        Buffer.from(expiry.toString().padStart(8, '0')),
      ]);

      const signature = nacl.sign.detached(validMessage, backend.secretKey);

      try {
        const headerSize = 16;
        const signatureLength = 64;
        const pubkeyLength = 32;
        const messageLength = tamperedMessage.length;

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
        edIxData.set(tamperedMessage, messageOffset);

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

        const tx = new Transaction().add(edIx).add(claimIx);
        tx.feePayer = claimant.publicKey;
        const { blockhash } = await provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(claimant);

        await provider.connection.sendTransaction(tx, [claimant]);
        expect.fail("Tampered message should have been rejected");
      } catch (error) {
        expect(error.message).to.include("0x2");
      }
    });

    it("Prevents wrong signer attacks", async () => {
      const nonce = 102;
      const expiry = Math.floor(Date.now() / 1000) + 3600;

      const message = Buffer.concat([
        airdropPda.toBuffer(),
        claimant.publicKey.toBuffer(),
        Buffer.from(nonce.toString().padStart(8, '0')),
        Buffer.from(expiry.toString().padStart(8, '0')),
      ]);

      // Sign with wrong key (attacker instead of backend)
      const wrongSignature = nacl.sign.detached(message, attacker.secretKey);

      try {
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

        edIxData.set(wrongSignature, signatureOffset);
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

        const tx = new Transaction().add(edIx).add(claimIx);
        tx.feePayer = claimant.publicKey;
        const { blockhash } = await provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(claimant);

        await provider.connection.sendTransaction(tx, [claimant]);
        expect.fail("Wrong signer should have been rejected");
      } catch (error) {
        expect(error.message).to.include("0x2");
      }
    });
  });

  describe("Access Control Security", () => {
    it("Prevents unauthorized withdrawal attempts", async () => {
      // Attacker tries to withdraw from airdrop they didn't create
      try {
        await program.methods
          .withdraw()
          .accounts({
            airdrop: airdropPda,
            creator: attacker.publicKey, // Wrong creator
            pdaAta: pdaAta,
            creatorAta: creatorAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Unauthorized withdrawal should have been prevented");
      } catch (error) {
        expect(error.message).to.include("ConstraintHasOne");
      }
    });

    it("Prevents unauthorized airdrop creation", async () => {
      // Attacker tries to create airdrop with someone else's tokens
      const attackerMint = await createMint(
        provider.connection,
        attacker,
        attacker.publicKey,
        null,
        MINT_DECIMALS
      );

      const attackerAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        attacker,
        attackerMint,
        attacker.publicKey,
        true
      ).then((ata) => ata.address);
      
      // Create the account if it doesn't exist
      try {
        await getAccount(provider.connection, attackerAta);
      } catch (error) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          attacker.publicKey,
          attackerAta,
          attacker.publicKey,
          attackerMint
        );
        
        const tx = new Transaction().add(createAtaIx);
        tx.feePayer = attacker.publicKey;
        const { blockhash } = await provider.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(attacker);
        
        await provider.connection.sendTransaction(tx, [attacker]);
      }

      // Mint tokens to attacker
      await mintTo(
        provider.connection,
        attacker,
        attackerMint,
        attackerAta,
        attacker,
        TOTAL_AMOUNT
      );

      // Try to create airdrop with wrong mint
      try {
        const [wrongAirdropPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("airdrop"), attacker.publicKey.toBuffer(), mint.toBuffer()], // Wrong mint
          program.programId
        );

        const wrongPdaAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          attacker,
          mint,
          wrongAirdropPda,
          true
        ).then((ata) => ata.address);

        await program.methods
          .createAirdrop(
            new anchor.BN(TOTAL_AMOUNT),
            new anchor.BN(CLAIM_AMOUNT),
            null,
            new anchor.BN(8192)
          )
          .accounts({
            creator: attacker.publicKey,
            backend: backend.publicKey,
            mint: mint, // Wrong mint
            airdrop: wrongAirdropPda,
            pdaAta: wrongPdaAta,
            creatorAta: attackerAta, // Wrong ATA
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Unauthorized airdrop creation should have been prevented");
      } catch (error) {
        // Should fail because attacker doesn't own the mint
        expect(error.message).to.include("ConstraintAssociated");
      }
    });
  });

  describe("Economic Attack Prevention", () => {
    it("Prevents overflow attacks with maximum values", async () => {
      const maxU64 = new anchor.BN("18446744073709551615"); // u64::MAX
      
      try {
        await program.methods
          .createAirdrop(
            maxU64,
            maxU64,
            null,
            new anchor.BN(8192)
          )
          .accounts({
            creator: creator.publicKey,
            backend: backend.publicKey,
            mint: mint,
            airdrop: airdropPda,
            pdaAta: pdaAta,
            creatorAta: creatorAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([creator])
          .rpc();
        expect.fail("Overflow attack should have been prevented");
      } catch (error) {
        // Should fail due to insufficient funds
        expect(error.message).to.include("0x0");
      }
    });
  });

  describe("Boundary Condition Security", () => {
    it("Handles nonce boundary conditions", async () => {
      // Test with nonce at bitmap boundary (8191)
      const boundaryNonce = 8191;
      const expiry = Math.floor(Date.now() / 1000) + 3600;

      const airdropPdaBuf = airdropPda.toBuffer();
      const claimantBuf = claimant.publicKey.toBuffer();
      const nonceBuf = Buffer.alloc(8);
      nonceBuf.writeBigUInt64LE(BigInt(boundaryNonce), 0);
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
      .claim(new anchor.BN(boundaryNonce), new anchor.BN(expiry))
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

      await provider.connection.sendTransaction(tx, [claimant]);

      // Test with nonce out of range (8192)
      try {
        const outOfRangeNonce = 8192;
        const airdropPdaBuf = airdropPda.toBuffer();
        const claimantBuf = claimant.publicKey.toBuffer();
        const nonceBuf = Buffer.alloc(8);
        nonceBuf.writeBigUInt64LE(BigInt(outOfRangeNonce), 0);
        const expiryBuf = Buffer.alloc(8);
        expiryBuf.writeBigInt64LE(BigInt(expiry), 0);
        const outOfRangeMessage = Buffer.concat([
          airdropPdaBuf,
          claimantBuf,
          nonceBuf,
          expiryBuf,
        ]);

        const outOfRangeSignature = nacl.sign.detached(outOfRangeMessage, backend.secretKey);
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
  
        edIxData.set(outOfRangeSignature, signatureOffset);
        edIxData.set(backend.publicKey.toBuffer(), pubkeyOffset);
        edIxData.set(outOfRangeMessage, messageOffset);
  
        const edIx = new anchor.web3.TransactionInstruction({
          programId: Ed25519Program.programId,
          keys: [],
          data: edIxData,
        });
  
        const claimIx = await program.methods
          .claim(new anchor.BN(outOfRangeNonce), new anchor.BN(expiry))
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
  
        const outOfRangeTx = new Transaction().add(edIx).add(claimIx);
        outOfRangeTx.feePayer = claimant.publicKey;
        const { blockhash: outOfRangeBlockhash } = await provider.connection.getLatestBlockhash();
        outOfRangeTx.recentBlockhash = outOfRangeBlockhash;
        outOfRangeTx.sign(claimant);

        await provider.connection.sendTransaction(outOfRangeTx, [claimant]);
        expect.fail("Out of range nonce should have been rejected");
      } catch (error) {
        expect(error.message).to.include("NonceOutOfRange");
      }
    });
  });
});

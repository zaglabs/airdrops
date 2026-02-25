import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { createTestHelper } from "./test-utils";
import "./test-setup";

describe("Airdrop Integration Tests", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const helper = createTestHelper(program, provider);

  let testEnv: any;
  let airdropPda: PublicKey;
  let pdaAta: PublicKey;
  let replayBitmapPda: PublicKey;

  const TOTAL_AMOUNT = 1000000;
  const CLAIM_AMOUNT = 10000;

  before(async () => {
    testEnv = await helper.setupTestEnvironment();

    const { airdropPda: airdrop, pdaAta: pda } = await helper.createAirdrop(
      testEnv.creator,
      testEnv.backend,
      testEnv.mint,
      testEnv.creatorAta,
      TOTAL_AMOUNT,
      CLAIM_AMOUNT,
      null // No expiration
    );

    airdropPda = airdrop;
    pdaAta = pda;
    replayBitmapPda = await helper.getReplayBitmapPda(airdropPda, testEnv.creator);
  });

  it("Complete airdrop flow: create -> claim -> withdraw", async () => {
    // Verify initial state
    const initialAirdrop = await program.account.airdrop.fetch(airdropPda);
    expect(initialAirdrop.claimedAmount.toNumber()).to.equal(0);
    expect(initialAirdrop.totalAmount.toNumber()).to.equal(TOTAL_AMOUNT);

    // Create destination token account for claimant
    const destAta = await helper.createAssociatedTokenAccountIfNeeded(
      testEnv.claimant,
      testEnv.claimant.publicKey,
      testEnv.mint
    );

    // Make multiple claims
    const nonces = [1, 2, 3, 4, 5];
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    for (const nonce of nonces) {
      const voucher = await helper.createVoucher(
        airdropPda,
        testEnv.claimant.publicKey,
        nonce,
        expiry,
        testEnv.backend
      );

      const txSignature = await helper.claimTokens(
        airdropPda,
        pdaAta,
        destAta,
        testEnv.claimant,
        replayBitmapPda,
        nonce,
        expiry,
        voucher
      );

      console.log(`Claimed with nonce ${nonce}:`, txSignature);
    }

    // Verify final state
    const finalAirdrop = await program.account.airdrop.fetch(airdropPda);
    expect(finalAirdrop.claimedAmount.toNumber()).to.equal(
      CLAIM_AMOUNT * nonces.length
    );

    const destBalance = await helper.getTokenAccountBalance(destAta);
    expect(destBalance).to.equal(CLAIM_AMOUNT * nonces.length);

    // Test withdrawal
    const initialCreatorBalance = await helper.getTokenAccountBalance(
      testEnv.creatorAta
    );

    await program.methods
      .withdraw()
      .accounts({
        airdrop: airdropPda,
        creator: testEnv.creator.publicKey,
        pdaAta: pdaAta,
        creatorAta: testEnv.creatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([testEnv.creator])
      .rpc();

    const finalCreatorBalance = await helper.getTokenAccountBalance(
      testEnv.creatorAta
    );
    const expectedRemaining = TOTAL_AMOUNT - CLAIM_AMOUNT * nonces.length;
    expect(finalCreatorBalance).to.equal(
      initialCreatorBalance + expectedRemaining
    );
  });

  it("Handles concurrent claims correctly", async () => {
    const newTestEnv = await helper.setupTestEnvironment();
    const newMint = newTestEnv.mint;
    const newCreatorAta = newTestEnv.creatorAta;
    const newCreator = newTestEnv.creator;
    const newBackend = newTestEnv.backend;
    const newClaimant = newTestEnv.claimant;

    const { airdropPda: newAirdropPda, pdaAta: newPdaAta } =
      await helper.createAirdrop(
        newCreator,
        newBackend,
        newMint,
        newCreatorAta,
        TOTAL_AMOUNT,
        CLAIM_AMOUNT,
        null
      );

    const newReplayBitmapPda = await helper.getReplayBitmapPda(newAirdropPda, newCreator);
    const newDestAta = await helper.createAssociatedTokenAccountIfNeeded(
      newClaimant,
      newClaimant.publicKey,
      newMint
    );

    // Create multiple vouchers for concurrent claims
    const nonces = [100, 101, 102, 103, 104];
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    const vouchers = await Promise.all(
      nonces.map((nonce) =>
        helper.createVoucher(
          newAirdropPda,
          newClaimant.publicKey,
          nonce,
          expiry,
          newBackend
        )
      )
    );

    // Execute claims concurrently
    const claimPromises = nonces.map((nonce, index) =>
      helper.claimTokens(
        newAirdropPda,
        newPdaAta,
        newDestAta,
        newClaimant,
        newReplayBitmapPda,
        nonce,
        expiry,
        vouchers[index]
      )
    );

    const txSignatures = await Promise.all(claimPromises);
    console.log("Concurrent claims completed:", txSignatures);

    // Verify all claims were successful
    const finalAirdrop = await program.account.airdrop.fetch(newAirdropPda);
    expect(finalAirdrop.claimedAmount.toNumber()).to.equal(
      CLAIM_AMOUNT * nonces.length
    );

    const destBalance = await helper.getTokenAccountBalance(newDestAta);
    expect(destBalance).to.equal(CLAIM_AMOUNT * nonces.length);
  });

  it("Handles edge cases and error conditions", async () => {
    const expiredTestEnv = await helper.setupTestEnvironment();
    const expiredCreator = expiredTestEnv.creator;
    const expiredBackend = expiredTestEnv.backend;
    const expiredClaimant = expiredTestEnv.claimant;
    const expiredMint = expiredTestEnv.mint;
    const expiredCreatorAta = expiredTestEnv.creatorAta;

    const pastTime = Math.floor(Date.now() / 1000) - 36000000; // 1 hour ago

    const { airdropPda: expiredAirdropPda, pdaAta: expiredPdaAta } =
      await helper.createAirdrop(
        expiredCreator,
        expiredBackend,
        expiredMint,
        expiredCreatorAta,
        TOTAL_AMOUNT,
        CLAIM_AMOUNT,
        pastTime
      );

    const expiredReplayBitmapPda = await helper.getReplayBitmapPda(
      expiredAirdropPda,
      expiredCreator
    );
    const expiredDestAta = await helper.createAssociatedTokenAccountIfNeeded(
      expiredClaimant,
      expiredClaimant.publicKey,
      expiredMint
    );

    // Try to claim from expired airdrop
    const voucher = await helper.createVoucher(
      expiredAirdropPda,
      expiredClaimant.publicKey,
      999,
      Math.floor(Date.now() / 1000) + 3600,
      expiredBackend
    );

    try {
      await helper.claimTokens(
        expiredAirdropPda,
        expiredPdaAta,
        expiredDestAta,
        expiredClaimant,
        expiredReplayBitmapPda,
        999,
        Math.floor(Date.now() / 1000) + 3600,
        voucher
      );
      expect.fail("Claim should have failed for expired airdrop");
    } catch (error) {
      expect(error.message).to.include("AirdropExpired");
    }
  });

  it("Stress test with many claims", async () => {
    // Create a new airdrop for stress testing
    const stressTestEnv = await helper.setupTestEnvironment();
    const stressCreator = stressTestEnv.creator;
    const stressBackend = stressTestEnv.backend;
    const stressClaimant = stressTestEnv.claimant;
    const stressMint = stressTestEnv.mint;
    const stressCreatorAta = stressTestEnv.creatorAta;

    const { airdropPda: stressAirdropPda, pdaAta: stressPdaAta } =
      await helper.createAirdrop(
        stressCreator,
        stressBackend,
        stressMint,
        stressCreatorAta,
        TOTAL_AMOUNT,
        CLAIM_AMOUNT,
        null
      );

    const stressReplayBitmapPda = await helper.getReplayBitmapPda(
      stressAirdropPda,
      stressCreator
    );
    const stressDestAta = await helper.createAssociatedTokenAccountIfNeeded(
      stressClaimant,
      stressClaimant.publicKey,
      stressMint
    );

    // Make many claims
    const numClaims = 50;
    const nonces = Array.from({ length: numClaims }, (_, i) => i + 1000);
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    console.log(`Making ${numClaims} claims...`);

    for (let i = 0; i < numClaims; i++) {
      const nonce = nonces[i];
      const voucher = await helper.createVoucher(
        stressAirdropPda,
        stressClaimant.publicKey,
        nonce,
        expiry,
        stressBackend
      );

      await helper.claimTokens(
        stressAirdropPda,
        stressPdaAta,
        stressDestAta,
        stressClaimant,
        stressReplayBitmapPda,
        nonce,
        expiry,
        voucher
      );

      if (i % 10 === 0) {
        console.log(`Completed ${i + 1}/${numClaims} claims`);
      }
    }

    // Verify final state
    const finalAirdrop = await program.account.airdrop.fetch(stressAirdropPda);
    expect(finalAirdrop.claimedAmount.toNumber()).to.equal(
      CLAIM_AMOUNT * numClaims
    );

    const destBalance = await helper.getTokenAccountBalance(stressDestAta);
    expect(destBalance).to.equal(CLAIM_AMOUNT * numClaims);

    console.log(
      `Stress test completed: ${numClaims} claims processed successfully`
    );
  });
});

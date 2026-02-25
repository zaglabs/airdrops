import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { createTestHelper } from "./test-utils";
import "./test-setup";

describe("Multi-Mint Airdrop Tests", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const helper = createTestHelper(program, provider);

  // Test constants
  const TOTAL_AMOUNT = 1000000;
  const CLAIM_AMOUNT = 10000;

  describe("Multiple Token Types", () => {
    it("Handles airdrops with different token decimals", async () => {
      const claimant = Keypair.generate();

      // Fund creator
      await provider.connection.requestAirdrop(
        claimant.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      // Create mints with different decimals
      const mints = [
        { decimals: 0, name: "whole tokens" },
        { decimals: 6, name: "standard tokens" },
        { decimals: 9, name: "high precision tokens" },
        { decimals: 18, name: "very high precision tokens" }
      ];

      const airdrops = [];

      for (const mintConfig of mints) {
        const testEnv = await helper.setupTestEnvironment(mintConfig.decimals);

        const { airdropPda, pdaAta } = await helper.createAirdrop(
          testEnv.creator,
          testEnv.backend,
          testEnv.mint,
          testEnv.creatorAta,
          TOTAL_AMOUNT,
          CLAIM_AMOUNT,
          null
        );

        airdrops.push({
          mint: testEnv.mint,
          airdropPda,
          pdaAta,
          backend: testEnv.backend,
          decimals: mintConfig.decimals,
          name: mintConfig.name
        });
      }

      // Test claiming from each airdrop
      for (let i = 0; i < airdrops.length; i++) {
        const airdrop = airdrops[i];
        const replayBitmapPda = await helper.getReplayBitmapPda(airdrop.airdropPda);

        const destAta = await helper.createAssociatedTokenAccountIfNeeded(
          claimant,
          claimant.publicKey,
          airdrop.mint
        );

        const nonce = 100 + i;
        const expiry = Math.floor(Date.now() / 1000) + 3600;

        const voucher = await helper.createVoucher(
          airdrop.airdropPda,
          claimant.publicKey,
          nonce,
          expiry,
          airdrop.backend
        );

        const txSignature = await helper.claimTokens(
          airdrop.airdropPda,
          airdrop.pdaAta,
          destAta,
          claimant,
          replayBitmapPda,
          nonce,
          expiry,
          voucher
        );

        console.log(`Claimed from ${airdrop.name} (${airdrop.decimals} decimals):`, txSignature);

        // Verify the claim was successful
        const airdropAccount = await program.account.airdrop.fetch(airdrop.airdropPda);
        expect(airdropAccount.claimedAmount.toNumber()).to.equal(CLAIM_AMOUNT);

        const destBalance = await helper.getTokenAccountBalance(destAta);
        expect(destBalance).to.equal(CLAIM_AMOUNT);
      }
    });
  });

  describe("Token Economics", () => {
    it("Handles different token supply scenarios", async () => {
      const claimant = Keypair.generate();

      // Fund creator
      await provider.connection.requestAirdrop(
        claimant.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      // Test with different supply scenarios
      const scenarios = [
        { totalAmount: 1000, claimAmount: 100, name: "small supply" },
        { totalAmount: 1000000, claimAmount: 10000, name: "medium supply" },
        { totalAmount: 1000000000, claimAmount: 1000000, name: "large supply" }
      ];

      for (const scenario of scenarios) {
        const testEnv = await helper.setupTestEnvironment();
        
        const { airdropPda, pdaAta } = await helper.createAirdrop(
          testEnv.creator,
          testEnv.backend,
          testEnv.mint,
          testEnv.creatorAta,
          scenario.totalAmount,
          scenario.claimAmount,
          null
        );

        const replayBitmapPda = await helper.getReplayBitmapPda(airdropPda);

        const destAta = await helper.createAssociatedTokenAccountIfNeeded(
          claimant,
          claimant.publicKey,
          testEnv.mint
        );

        const nonce = 500 + scenarios.indexOf(scenario);
        const expiry = Math.floor(Date.now() / 1000) + 3600;

        const voucher = await helper.createVoucher(
          airdropPda,
          claimant.publicKey,
          nonce,
          expiry,
          testEnv.backend
        );

        const txSignature = await helper.claimTokens(
          airdropPda,
          pdaAta,
          destAta,
          claimant,
          replayBitmapPda,
          nonce,
          expiry,
          voucher
        );

        console.log(`Claimed from ${scenario.name}:`, txSignature);

        // Verify the claim
        const airdropAccount = await program.account.airdrop.fetch(airdropPda);
        expect(airdropAccount.claimedAmount.toNumber()).to.equal(scenario.claimAmount);

        const destBalance = await helper.getTokenAccountBalance(destAta);
        expect(destBalance).to.equal(scenario.claimAmount);
      }
    });

    it("Handles token precision edge cases", async () => {
      const claimant = Keypair.generate();

      // Fund creator
      await provider.connection.requestAirdrop(
        claimant.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      // Test with very high precision tokens (18 decimals)
      const testEnv = await helper.setupTestEnvironment(18);
      
      const { airdropPda, pdaAta } = await helper.createAirdrop(
        testEnv.creator,
        testEnv.backend,
        testEnv.mint,
        testEnv.creatorAta,
        TOTAL_AMOUNT,
        CLAIM_AMOUNT,
        null
      );

      const replayBitmapPda = await helper.getReplayBitmapPda(airdropPda);

      const destAta = await helper.createAssociatedTokenAccountIfNeeded(
        claimant,
        claimant.publicKey,
        testEnv.mint
      );

      const nonce = 600;
      const expiry = Math.floor(Date.now() / 1000) + 3600;

      const voucher = await helper.createVoucher(
        airdropPda,
        claimant.publicKey,
        nonce,
        expiry,
        testEnv.backend
      );

      const txSignature = await helper.claimTokens(
        airdropPda,
        pdaAta,
        destAta,
        claimant,
        replayBitmapPda,
        nonce,
        expiry,
        voucher
      );

      console.log("Claimed from high precision mint:", txSignature);

      // Verify the claim
      const airdropAccount = await program.account.airdrop.fetch(airdropPda);
      expect(airdropAccount.claimedAmount.toNumber()).to.equal(CLAIM_AMOUNT);

      const destBalance = await helper.getTokenAccountBalance(destAta);
      expect(destBalance).to.equal(CLAIM_AMOUNT);
    });
  });

  describe("Complex Multi-Mint Scenarios", () => {
    it("Handles withdrawal from multiple airdrops", async () => {
      const creator = Keypair.generate();
      const backend = Keypair.generate();
      const claimant = Keypair.generate();

      // Fund creator
      const initialBalance = await provider.connection.requestAirdrop(
        creator.publicKey,
        3 * anchor.web3.LAMPORTS_PER_SOL
      );

      await provider.connection.confirmTransaction(
        initialBalance,
        "confirmed"
      );

      const initialBalanceClaimant = await provider.connection.requestAirdrop(
        claimant.publicKey,
        3 * anchor.web3.LAMPORTS_PER_SOL
      );

      await provider.connection.confirmTransaction(
        initialBalanceClaimant,
        "confirmed"
      );

      // Create multiple airdrops
      const mints = await Promise.all([
         6,
         9,
         0
      ]);

      const airdrops = await Promise.all(
        mints.map(async (mint, index) => {
          const testEnv = await helper.setupTestEnvironment(mint);
          const { airdropPda, pdaAta } = await helper.createAirdrop(
            testEnv.creator,
            testEnv.backend,
            testEnv.mint,
            testEnv.creatorAta,
            TOTAL_AMOUNT,
            CLAIM_AMOUNT,
            null
          );

          const replayBitmapPda = await helper.getReplayBitmapPda(airdropPda);

          return {
            mint: testEnv.mint,
            airdropPda,
            pdaAta,
            replayBitmapPda,
            backend: testEnv.backend,
            creator: testEnv.creator,
            creatorAta: testEnv.creatorAta,
          };
        })
      );

      // Make some claims to reduce available amounts
      const destAtas = await Promise.all(
        airdrops.map(async (airdrop) => {
          return await helper.createAssociatedTokenAccountIfNeeded(
            claimant,
            claimant.publicKey,
            airdrop.mint
          );
        })
      );

      const expiry = Math.floor(Date.now() / 1000) + 3600;
      
      // Claim from each airdrop
      for (let i = 0; i < airdrops.length; i++) {
        const airdrop = airdrops[i];
        const nonce = 800 + i;

        const voucher = await helper.createVoucher(
          airdrop.airdropPda,
          claimant.publicKey,
          nonce,
          expiry,
          airdrop.backend
        );

        await helper.claimTokens(
          airdrop.airdropPda,
          airdrop.pdaAta,
          destAtas[i],
          claimant,
          airdrop.replayBitmapPda,
          nonce,
          expiry,
          voucher
        );
      }

      // Get initial creator balances
      const initialBalances = await Promise.all(
        airdrops.map(async (airdrop) => {
          return await helper.getTokenAccountBalance(airdrop.creatorAta);
        })
      );

      // Withdraw from each airdrop
      for (let i = 0; i < airdrops.length; i++) {
        const airdrop = airdrops[i];

        await program.methods
          .withdraw()
          .accounts({
            airdrop: airdrop.airdropPda,
            creator: airdrop.creator.publicKey,
            pdaAta: airdrop.pdaAta,
            creatorAta: airdrop.creatorAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([airdrop.creator])
          .rpc();

        // Verify withdrawal
        const finalBalance = await helper.getTokenAccountBalance(airdrop.creatorAta);
        const expectedBalance = initialBalances[i] + (TOTAL_AMOUNT - CLAIM_AMOUNT);
        expect(finalBalance).to.equal(expectedBalance);
      }
    });
  });
});

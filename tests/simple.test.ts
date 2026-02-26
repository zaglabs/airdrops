import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import "./test-setup";

describe("Simple Airdrop Test", () => {
  const program = anchor.workspace.Airdrop;
  const provider = anchor.getProvider();
  const connection = provider.connection;

  it("Should connect to local validator", async () => {
    try {
      const version = await connection.getVersion();
      expect(version).to.exist;
      console.log("✅ Connected to Solana validator:", version);
    } catch (error) {
      console.log("❌ Failed to connect to Solana validator");
      throw error;
    }
  });

  it("Should create test accounts", () => {
    const creator = Keypair.generate();
    const backend = Keypair.generate();
    const claimant = Keypair.generate();

    expect(creator.publicKey).to.exist;
    expect(backend.publicKey).to.exist;
    expect(claimant.publicKey).to.exist;

    console.log("✅ Test accounts created successfully");
  });

  it("Should derive PDAs correctly", () => {
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const nonce = Keypair.generate();

    const [airdropPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("airdrop"),
        creator.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
        nonce.publicKey.toBuffer(),
      ],
      program.programId,
    );

    const [replayBitmapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), airdropPda.toBuffer()],
      program.programId,
    );

    expect(airdropPda).to.exist;
    expect(replayBitmapPda).to.exist;

    console.log("✅ PDAs derived successfully");
    console.log("Airdrop PDA:", airdropPda.toString());
    console.log("Replay Bitmap PDA:", replayBitmapPda.toString());
  });

  it("Should create voucher message correctly", () => {
    const airdropPda = Keypair.generate().publicKey;
    const claimant = Keypair.generate().publicKey;
    const amount = 10000;
    const nonce = 42;
    const expiry = Math.floor(Date.now() / 1000) + 3600;

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

    expect(message.length).to.equal(88); // 32 + 32 + 8 + 8 + 8
    expect(message.slice(0, 32)).to.deep.equal(airdropPdaBuf);
    expect(message.slice(32, 64)).to.deep.equal(claimantBuf);
    expect(message.slice(64, 72)).to.deep.equal(amountBuf);
    expect(message.slice(72, 80)).to.deep.equal(nonceBuf);
    expect(message.slice(80, 88)).to.deep.equal(expiryBuf);

    console.log("✅ Voucher message created correctly");
  });

  it("Should test ed25519 signature creation", () => {
    const nacl = require("tweetnacl");
    const backend = Keypair.generate();
    const message = Buffer.from("test message");

    const signature = nacl.sign.detached(message, backend.secretKey);
    const isValid = nacl.sign.detached.verify(
      message,
      signature,
      backend.publicKey.toBuffer(),
    );

    expect(isValid).to.be.true;
    console.log("✅ Ed25519 signature creation and verification works");
  });
});

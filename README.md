# Airdrops

Solana program (Anchor) for token airdrops with backend-signed vouchers, replay protection, and per-instance fees.

## Features

- **Voucher-based claims** — Users claim tokens by submitting a transaction that includes an ed25519 precompile instruction; the program verifies the signature against a backend pubkey and a signed message (amount, nonce, expiry, claimant).
- **Replay protection** — A bitmap per airdrop marks used voucher indices so each voucher can be claimed only once.
- **Per-instance fees** — Optional SOL fee on `create_airdrop`, configurable per fee recipient via instance accounts (admin sets `fee_lamports`).
- **Creator controls** — Pause/unpause airdrop, update backend pubkey, withdraw unclaimed tokens (after expiry or when done).
- **Instance lifecycle** — A single `INSTANCE_AUTHORITY` (in program) can create/close instance PDAs; instance admin can update the fee.

## How it works

1. **Instance**: `INSTANCE_AUTHORITY` creates an instance per fee recipient; that instance’s admin sets the SOL fee for `create_airdrop`.
2. **Create airdrop**: Creator locks tokens into a PDA and specifies total amount and voucher bitmap size. If using an instance, they pay the instance’s fee to the fee recipient.
3. **Claim**: User sends a transaction containing an ed25519 verify instruction (signature over amount, nonce, expiry, claimant) and a `claim(amount, nonce, expiry)` instruction. Program checks the precompile, expiry, and replay bitmap, then transfers tokens to the user.
4. **Backend**: Off-chain service holds the backend keypair, issues vouchers (signs the message), and can be rotated via `update_backend`.

## Prerequisites

- [Rust](https://rustup.rs/) (with a Solana-friendly version if needed)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) (v0.30.x)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- Node.js 18+ (for tests and migrations)

## Build

```bash
anchor build
```

## Configuration

Copy `.env.example` to `.env` and fill in values. Required for migrations and fee-system tests:

| Variable | Description |
| -------- | ----------- |
| `ANCHOR_PROVIDER_URL` | RPC URL (e.g. `http://127.0.0.1:8899` for localnet) |
| `ANCHOR_WALLET` | Path to keypair JSON for deploy/migrate |
| `FEE_RECIPIENT_1` / `FEE_RECIPIENT_2` | Fee recipient pubkeys (base58) |
| `AUTHORITY_SEED_1` / `AUTHORITY_SEED_2` | 64-char hex seeds for instance admin keypairs |
| `FEE_AMOUNT_1` / `FEE_AMOUNT_2` | Fee in lamports per `create_airdrop` |

## Deploy and migrate

1. Point `Anchor.toml` (or env) to the desired cluster and wallet.
2. Deploy the program:

   ```bash
   anchor deploy
   ```

3. Run the migration (creates two fee instances; deployer must be `INSTANCE_AUTHORITY`):

   ```bash
   anchor run migrate
   ```

   Ensure `.env` has `FEE_RECIPIENT_1`, `FEE_AMOUNT_1`, `AUTHORITY_SEED_1`, and the same for `_2`.

## Tests

1. Start a local validator:

   ```bash
   solana-test-validator
   ```

2. Build and run tests:

   ```bash
   anchor build
   npm run test
   ```

   For fee-system tests, run the migration first and set the fee-related vars in `.env`. See [tests/README.md](tests/README.md) for details and per-file test commands.

## Project structure

```text
├── Anchor.toml           # Anchor workspace and provider config
├── programs/
│   └── airdrop/          # Anchor program (Rust)
│       └── src/lib.rs
├── migrations/
│   └── deploy.ts         # Post-deploy: create two fee instances
├── tests/                # TypeScript tests (Mocha)
│   ├── README.md
│   ├── airdrop.test.ts
│   ├── voucher.test.ts
│   ├── bitmap.test.ts
│   ├── integration.test.ts
│   ├── fee-system.test.ts
│   └── test-utils.ts
├── .env.example
└── package.json
```

## Program instructions

| Instruction | Who | Description |
| ----------- | --- | ----------- |
| `create_instance` | INSTANCE_AUTHORITY | Create instance PDA for a fee recipient and set admin + fee. |
| `close_instance` | INSTANCE_AUTHORITY | Close instance PDA and reclaim rent. |
| `update_instance` | Instance admin | Update `fee_lamports` for that instance. |
| `create_airdrop` | Anyone | Create airdrop (tokens locked in PDA; fee from instance required). |
| `claim` | Anyone | Claim with ed25519 voucher (amount, nonce, expiry) and replay check. |
| `withdraw` | Airdrop Creator | Withdraw unclaimed tokens from airdrop PDA. |
| `set_paused` | Airdrop Creator | Pause or unpause an airdrop. |
| `update_backend` | Airdrop Creator | Set new backend pubkey for voucher verification. |

## Security note

The pubkey that may call `create_instance` and `close_instance` is fixed in the program as `INSTANCE_AUTHORITY`. For your own deployment, change this constant in `programs/airdrop/src/lib.rs` to your deployer or DAO and rebuild.

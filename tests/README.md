# Airdrop Program Tests

This directory contains comprehensive TypeScript tests for the airdrop program.

## General test flow (funding and cleanup)

1. **Provider funds accounts** — Tests use the provider wallet (from test-setup) to fund test accounts (e.g. via transfers or helpers). No `requestAirdrop` in fee-system; other files may use it or the same pattern.
2. **Tests run** — Use the funded accounts as needed.
3. **Cleanup: drain back to provider** — At the end of the suite (e.g. in an `after()` hook), every account that was funded from the provider must send its remaining SOL back to the provider so nothing is left behind. Use `drainToProvider` (see `test-utils.ts`): track funded keypairs and drain each in `after()`. **Fee accounts** (accounts that received fee SOL) must be drained with **leave rent**: use `drainToProvider(connection, provider, keypair, { leaveRent: true })` so the account keeps the rent-exempt minimum.

This flow applies to every test file: fund from provider → run tests → drain funded accounts back to provider (leave rent for fee accounts).

## Test Files

### `airdrop.test.ts`

Main test suite covering:

- Airdrop creation
- Token claiming with valid vouchers
- Invalid voucher rejection
- Expired voucher handling
- Replay attack prevention
- Creator withdrawal functionality
- Access control validation

### `voucher.test.ts`

Tests for the ed25519 voucher system:

- Voucher message construction
- Signature creation and verification
- Invalid signature rejection
- Multiple voucher handling
- Edge case nonce values
- Boundary condition testing

### `bitmap.test.ts`

Tests for the replay protection bitmap:

- Bitmap initialization
- Bit setting and checking
- Replay attack prevention
- Boundary condition testing
- Byte boundary handling
- Bitmap persistence

### `integration.test.ts`

End-to-end integration tests:

- Complete airdrop flow
- Concurrent claim handling
- Error condition testing
- Stress testing with many claims

### `test-utils.ts`

Utility functions for test setup:

- Test environment creation
- Airdrop creation helpers
- Voucher generation
- Token account management
- Balance checking utilities

### Fee configuration (createAirdrop) — one instance per recipient

The program charges an optional SOL fee for `createAirdrop`. Each fee recipient has its own **instance account** (no global allowlist).

1. **Creating an instance:** Only **INSTANCE_AUTHORITY** (hardcoded in the program) may call `createInstance`. The authority passes an **admin** (stored on the instance); the authority pays rent. The instance is keyed by `feeRecipient` (seeds `["instance", feeRecipient]`).
2. **Updating the fee:** Only that instance's **admin** can call `updateInstance(feeLamports)` to change the fee.
3. **createAirdrop** takes `(totalAmount, vouchersSizeBits)` and accounts `instanceConfig`, `feeRecipient`. The fee is read from `instanceConfig.feeLamports` on-chain and transferred to `feeRecipient` when > 0 (no fee amount argument).

For tests: build the program with `INSTANCE_AUTHORITY` set to your test wallet. Fee system tests (`tests/fee-system.test.ts`) use the same config as the migration: set **FEE_RECIPIENT_1**, **FEE_AMOUNT_1**, **FEE_RECIPIENT_2**, **FEE_AMOUNT_2** in `.env`. Run the migration first so those instances exist. The create_airdrop fee tests use **FEE_RECIPIENT_1** and **FEE_AMOUNT_1** (fee transfer and insufficient-SOL test).

## Running Tests

### Prerequisites

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start a local Solana validator:

   ```bash
   solana-test-validator
   ```

3. Build the program:

   ```bash
   anchor build
   ```

### Running All Tests

```bash
npm run test
```

### Running Individual Test Files

```bash
# Run main airdrop tests
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/airdrop.test.ts

# Run voucher system tests
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/voucher.test.ts

# Run bitmap tests
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/bitmap.test.ts

# Run integration tests
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/integration.test.ts
```

## Test Coverage

The tests cover:

### Security Features

- ✅ Ed25519 voucher verification
- ✅ Replay attack prevention
- ✅ Expiration handling
- ✅ Access control
- ✅ Invalid signature rejection

### Functionality

- ✅ Airdrop creation
- ✅ Token claiming
- ✅ Creator withdrawal
- ✅ Balance tracking
- ✅ PDA management

### Edge Cases

- ✅ Boundary nonce values
- ✅ Byte boundary conditions
- ✅ Concurrent operations
- ✅ Stress testing
- ✅ Error conditions

### Integration

- ✅ End-to-end workflows
- ✅ Multiple user scenarios
- ✅ Error recovery
- ✅ State persistence

## Test Structure

Each test file follows this pattern:

1. **Setup**: Create test accounts and environment
2. **Execute**: Run the functionality being tested
3. **Verify**: Check that results match expectations
4. **Cleanup**: Reset state for next test

## Dependencies

- `@coral-xyz/anchor`: Anchor framework
- `@solana/web3.js`: Solana web3 utilities
- `@solana/spl-token`: SPL token program
- `tweetnacl`: Ed25519 cryptography
- `chai`: Assertion library
- `mocha`: Test framework
- `ts-mocha`: TypeScript Mocha runner

## Notes

- Tests use a local Solana validator for isolation
- Each test creates fresh accounts to avoid conflicts
- Tests include proper error handling and validation
- All tests are designed to be deterministic and repeatable

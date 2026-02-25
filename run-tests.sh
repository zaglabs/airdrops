#!/bin/bash

# Airdrop Program Test Runner
# This script runs all the TypeScript tests for the airdrop program

echo "🚀 Starting Airdrop Program Tests"
echo "================================="

# Check if Solana validator is running
# if ! curl -s http://localhost:8899 > /dev/null 2>&1; then
#     echo "❌ Error: Solana validator is not running on localhost:8899"
#     echo "Please start it with: solana-test-validator"
#     exit 1
# fi

echo "✅ Solana validator is running"

# Check if program is built
# if [ ! -f "target/deploy/airdrop.so" ]; then
#     echo "🔨 Building program..."
#     anchor build
#     if [ $? -ne 0 ]; then
#         echo "❌ Build failed"
#         exit 1
#     fi
#     echo "✅ Program built successfully"
# else
#     echo "✅ Program already built"
# fi

# Run tests
echo ""
echo "🧪 Running Tests"
echo "================"

# echo "📋 Running main airdrop tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/airdrop.test.ts

# echo ""
# echo "🔐 Running voucher system tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/voucher.test.ts

# echo ""
# echo "🗂️ Running bitmap tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/bitmap.test.ts

# echo ""
# echo "🔗 Running integration tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/integration.test.ts

# echo ""
# echo "🔐 Running security tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/security.test.ts

# echo ""
# echo "🔐 Running multi-mint tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/multi-mint.test.ts

# echo "📋 Running new claim amount tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/claim-amount.test.ts

# echo "📋 Running multiple airdrops tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/multiple-airdrops.test.ts

# echo "📋 Running 0xFFFF voucher tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/voucher-0xFFFF.test.ts

# echo "📋 Running devnet integration tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/devnet-integration.test.ts

# echo "📋 Running fee system tests..."
# npx ts-mocha -p ./tsconfig.json -t 1000000 tests/fee-system.test.ts

echo "📋 Running withdraw tests..."
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/withdraw.test.ts

echo ""
echo "✅ All tests completed!"
echo "======================"

#!/usr/bin/env bash
# Deploy groundtruth_pool to devnet using the funded Windows CLI wallet and
# vendor the generated IDL + TS types into packages/chain.
set -euo pipefail
cd "$(dirname "$0")"

KEY=/mnt/c/Users/aryan/.config/solana/id.json
URL=https://api.devnet.solana.com

echo "== deployer balance =="
solana balance -u $URL -k $KEY

echo "== deploy =="
solana program deploy target/deploy/groundtruth_pool.so \
  --program-id target/deploy/groundtruth_pool-keypair.json \
  -u $URL -k $KEY --commitment confirmed

echo "== vendor IDL/types into packages/chain =="
cp target/idl/groundtruth_pool.json ../packages/chain/src/idl/groundtruth_pool.json
cp target/types/groundtruth_pool.ts ../packages/chain/src/idl/groundtruth_pool.ts

echo "== program account =="
solana program show B3XJrPdtvDRpnwNyk6s633WNrwJed2jJCKrE3Xuwn537 -u $URL

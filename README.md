# Groundtruth — verifiable World Cup prediction market (Solana devnet)

> Most prediction markets ask you to trust their oracle. **Groundtruth hands you the proof.**

Every Class-A market settles through an on-chain Merkle proof of the real match statistic,
verified by the [TxLINE](https://txline.txodds.com/documentation/quickstart) `txoracle`
program against the daily scores root it posts on Solana. Anyone can re-run the check —
the **Re-verify** button in the app does exactly that, from your own browser.

## Architecture

```
apps/web        Vite + React SPA (wallet-adapter; deposit/claim are user-signed)
apps/server     Fastify API + auto-market engine, live SSE indexer, settler/keeper,
                position indexer + leaderboard (SQLite via Drizzle)
packages/
  shared        network constants, plain market-terms type
  txline-client TxLINE REST/SSE client (guest JWT → subscribe → activate)
  chain         txoracle + pool program clients, proof assembly, terms_hash
  catalog       provable stat catalog, market templates, lock rules, status map
program/        groundtruth_pool — parimutuel YES/NO pools per terms_hash;
                permissionless resolution via CPI into txoracle validate_stat;
                optimistic dispute window (later proof supersedes); pro-rata payout
```

Why a custom pool program: TxLINE's own matching (`execute_match`) and direct trades
(`create_trade`) are authority-gated on devnet, so third parties cannot complete the
escrow loop with the native primitives. The pool program keeps custody minimal and
resolution anchored to TxLINE's proof — no self-invented oracle.

## Running

```sh
pnpm install
pnpm exec tsx apps/server/scripts/01-faucet.ts            # keeper devnet USDT
pnpm exec tsx apps/server/scripts/02-subscribe-activate.ts # TxLINE free-tier access
pnpm dev:server   # API on :8787 + all background services
pnpm dev:web      # SPA on :5173 (proxies /api)
```

The Anchor program builds in WSL (`program/fix-and-build.sh`) — see
`program/` for the pinned-lockfile story — and deploys with
`solana program deploy` against devnet.

## Demo path (spec §14)

1. Connect wallet → 💧 Faucet (100 devnet USDT, self-serve).
2. Pick a Class-A live card (e.g. *Over 2.5 goals*), stake a side — `deposit` is signed
   by your wallet, funds sit in the market-PDA vault.
3. At full time the settler fetches the Merkle proof and calls the permissionless
   `resolve`; the pool program CPIs into `validate_stat`, which re-verifies the proof
   against the on-chain daily root before the outcome is stored.
4. Open the receipt: proven stat, root PDA, settlement tx, plain-English line — and hit
   **Re-verify yourself** to re-run the on-chain check read-only from the browser.
5. Claim: winners take stake + pro-rata share of the losing pool.

Class-B (player prop) cards are labeled **Feed-resolved** — attested by feed snapshot,
never dressed up as chain-verified. That honesty is the product.

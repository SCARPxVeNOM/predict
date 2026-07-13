# Winners'Club 🏆

**Provably-fair prediction markets for the FIFA World Cup 2026, settled by cryptographic proof instead of an admin's say-so.**

**Live app:** https://winnerclub.vercel.app · **API:** https://groundtruth-server-production-569f.up.railway.app · **Network:** Solana devnet

---

## The problem

Every prediction market has the same trust hole: *who decides the outcome?* Even the biggest platforms resolve markets through a human committee, a multisig, or an oracle vote. That resolver can be wrong, slow, captured, or corrupt — and the user staking their money has no way to independently check the answer. "Trust us, the market resolved YES" is not a proof.

## What Winners'Club does

Winners'Club settles every match market against **TxLINE's on-chain Merkle commitment of the licensed match data** — not against anyone's opinion.

Users stake devnet USDT into YES/NO parimutuel pools on World Cup markets. When a match ends, **anyone** can permissionlessly resolve the pool by submitting a Merkle proof of the deciding stat. Our on-chain program verifies that proof via CPI into TxLINE's `txoracle` program against its posted daily scores root. No admin key decides. No oracle committee votes. The licensed data feed's own on-chain commitment is the sole source of truth.

Every settled market publishes a **receipt** — the proven stat leaves, the root PDA, and the settlement transaction — that any user can **re-verify straight from their own browser** with a read-only `validate_stat` call. The outcome is a fact you can check yourself, not a claim you have to believe.

> **Prices come from money, outcomes come from proofs.** Odds are pure pool ratios — the data feed never prices anything. Traders price the market; the feed settles it.

---

## How it works

```
  Trader ──stake USDT──▶  Parimutuel pool (Anchor PDA, seeded by sha256(borsh(terms)))
                                     │
  Match ends                         │  anyone calls resolve(proof)
     │                               ▼
  TxLINE posts daily         Pool program ──CPI──▶ txoracle.validate_stat
  scores root on-chain                 │                    │
     │                                 │          verifies Merkle proof
     └─────────────────────────────────┴──────────▶  against on-chain root
                                       │
                        Winner side set · 30-min dispute window · pro-rata claims
                                       │
                                  Receipt published ──▶ browser re-verify (read-only .view())
```

1. **Markets are minted automatically.** A catalog engine mints ~20 Class-A markets per fixture (match result, over/under goals including first-half variants, corners, cards, margins, BTTS composites). An AI author (Gemini, used strictly as a *parser* of TxLINE data) adds pre-match specials grounded in real knockout form and in-play markets during live matches — fired at kickoff / half-time / ~60' from the live feed, never on a blind timer.
2. **Every AI-authored market must survive a gauntlet** before it can ship: a strict provable-stat grammar, a bookmaker-style balance guard that rejects one-sided lines, entity-name validation, and terms-hash dedupe. A market the held data cannot settle *structurally cannot exist*.
3. **Traders stake** devnet USDT (self-serve faucet built in) into the YES or NO pool. Odds are the live pool ratio.
4. **At full time, the settler resolves permissionlessly.** It polls the `daily_scores_roots` PDA for the batch root, fetches the Merkle proof, and CPIs into `validate_stat`. A 30-minute optimistic dispute window lets later match evidence supersede. Winners claim pro-rata.
5. **Unprovable markets void and refund.** If the feed's coverage window can never settle a market, the settler recognizes it and returns everyone's stake.

---

## Why it's honest by construction

- **Markets exist only if held data can settle them.** We removed tournament award markets (Golden Boot, etc.) after proving the feed's coverage window can't see the group stage — an unprovable market is a dishonest market, so it doesn't ship.
- **Every card is labeled** Class-A chain-verified vs. chain-composed vs. feed-attested. No feed-attested card ever borrows chain-verified styling.
- **The database is only a cache of the chain.** After any DB loss, market rows and receipts are reconstructed from on-chain pool accounts and re-fetched proofs — the chain is the source of record.
- **Feed data is treated as adversarial.** Terminal match statuses are sticky, a time-plus-score rule finalizes fixtures even when the feed regresses, and settlement survives RPC rate-limit storms.

---

## How TxLINE powers the backend

TxLINE (TxOdds' licensed sports-data oracle) is the entire trust anchor. Winners'Club never invents a fact — it only reads, proves, and settles against TxLINE.

**REST / SSE** (base `https://txline-dev.txodds.com`):

| Surface | Use |
|---|---|
| `POST /auth/guest/start` | guest JWT for the free tier |
| `POST /api/token/activate` | activate API token (signed `txSig:leagues:jwt` message) |
| `GET /api/fixtures/snapshot?startEpochDay=` | fixture schedule sync (competition 72) |
| `GET /api/scores/stream` (SSE) | live indexer: statuses, clocks, scores, stat maps, goal actions |
| `GET /api/scores/snapshot/{fixtureId}` | hydration, deciding-record selection, scorer aggregation, stale-fixture repair |
| `GET /api/scores/historical/{fixtureId}` | replay / coverage probes |
| `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=` | Merkle proof bundles for settlement, receipts, and browser re-verify |

**On-chain** (txoracle `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`):

- `subscribe` — free-tier data subscription (the activation tx)
- `request_devnet_faucet` — self-serve 100 devnet USDT for any wallet (the in-app faucet)
- `validate_stat` — called two ways: **CPI from our pool program** during `resolve` (fund-moving, trustless) and **read-only `.view()` from the user's browser** for independent receipt re-verification
- `daily_scores_roots` PDA (`["daily_scores_roots", u16le epochDay]`) — the root of trust every proof verifies against

---

## Architecture

| Layer | Tech | Responsibility |
|---|---|---|
| **On-chain** | Anchor / Rust — pool program `B3XJrPdtvDRpnwNyk6s633WNrwJed2jJCKrE3Xuwn537` | YES/NO parimutuel pools; permissionless proof-gated `resolve` via CPI into txoracle; dispute window; pro-rata claim; void + refund |
| **Backend** | Fastify + SQLite/Drizzle on Railway | live indexer, auto-market catalog engine, AI author, settler/keeper, position indexer, REST + SSE API |
| **Frontend** | Vite / React + Solana wallet-adapter on Vercel | Live & Predictions market cards, faucet, trade flow, receipts gallery, browser-side re-verify, leaderboard |
| **AI** | Gemini free tier (key × model rotation) | authors market questions **from TxLINE data only** — a parser, never a source of truth |

The custom parimutuel pool program exists because TxLINE's own trading rails are authority-gated on devnet (`execute_match` requires oracle authority, `create_trade` needs a co-signer). So Winners'Club custodies stakes in its own pools and borrows only the piece that matters — TxLINE's `validate_stat` proof verification — for settlement.

---

## The receipt: what makes a settlement checkable

Each settled Class-A market carries a receipt containing the market terms and their hash, the deciding record sequence, the proven stat leaves, the `daily_scores_roots` PDA and its hash, and the settlement transaction signature. The **Proofs** page in the app is a verification gallery: pick any settled market, expand its receipt, and hit **Re-verify** — your browser runs `validate_stat` as a read-only call against the same on-chain root and shows you the boolean. You never take our word for it.

---

## Status

Live on **Solana devnet**. The full settlement loop is proven end-to-end on real World Cup fixtures: markets auto-created, traders staked opposite sides, matches settled on-chain via proof→CPI (including extra-time and penalty-shootout matches), winners claimed pro-rata, receipts re-verified from the browser. Odds, sparklines, P&L, and verified-accuracy on the leaderboard are all computed from real on-chain pool state — no mock data anywhere.

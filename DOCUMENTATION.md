# Winners'Club 🏆 — Brief Technical Documentation

**Live app:** https://winnerclub.vercel.app · **API:** https://groundtruth-server-production-569f.up.railway.app · **Network:** Solana devnet only

## Core idea

A prediction market for the FIFA World Cup 2026 where **every settlement is a cryptographic fact, not an opinion**. Users stake devnet USDT into YES/NO parimutuel pools on match markets; when the match ends, anyone can permissionlessly resolve the pool by submitting a Merkle proof of the deciding stat, which our on-chain program verifies via CPI into TxLINE's `txoracle` program against its posted daily scores root. No admin key decides outcomes, no oracle committee votes — the licensed data feed's own on-chain commitment does. Every settled market publishes a receipt (proven stat leaves, root PDA, settlement tx) that any user can **re-verify from their own browser** with a read-only `validate_stat` call.

## Business / technical highlights

- **Custom parimutuel pool program** (Anchor, devnet `B3XJrPdtvDRpnwNyk6s633WNrwJed2jJCKrE3Xuwn537`): markets are PDAs seeded by `sha256(borsh(market terms))`; `resolve` is permissionless and CPIs into txoracle's `validate_stat` with the caller-supplied proof; optimistic 30-minute dispute window where later match evidence supersedes; pro-rata claims; automatic void+refund for anything unresolvable.
- **Prices come from money, outcomes from proofs.** Odds are pure pool ratios (total/side) — the data feed never prices anything. The feed settles; traders price.
- **Fully automated market lifecycle**: a catalog engine mints ~20 markets per fixture (result, O/U goals incl. first-half variants, corners, cards, margins, BTTS composite); an AI author (Gemini free tier, key×model rotation) adds pre-match specials grounded in knockout form and in-play markets during live matches (fired at kickoff/HT/60' from the live feed, never on a timer). Every AI proposal must survive a strict provable-stat grammar, a bookmaker-style balance guard (one-sided lines rejected), entity-name checks, and terms-hash dedupe — a wrong or unsettleable market structurally cannot ship.
- **Honesty as an architecture rule**: markets exist only if held data can settle them (we removed tournament award markets after proving the feed's coverage window can't see the group stage); Class-A chain-verified vs. chain-composed vs. feed-attested labeling on every card; DB is treated as a cache of the chain — after any DB loss, market rows and receipts are reconstructed from on-chain pool accounts and re-fetched proofs.
- **Resilience learned from production**: feed statuses are treated as adversarial (terminal statuses are sticky, a time+score rule finalizes fixtures even when the feed regresses), settlement survives RPC rate limits, and the settler recognizes permanently-unprovable markets and voids them for refunds.

## TxLINE endpoints & on-chain surfaces used

REST/SSE (base `https://txline-dev.txodds.com`):

| Surface | Use |
|---|---|
| `POST /auth/guest/start` | guest JWT for the free tier |
| `POST /api/token/activate` | activate API token (signed `txSig:leagues:jwt` message) |
| `GET /api/fixtures/snapshot?startEpochDay=` | fixture schedule sync (competition 72) |
| `GET /api/scores/stream` (SSE) | live indexer: statuses, clocks, scores, stat maps, goal actions |
| `GET /api/scores/snapshot/{fixtureId}` | hydration, deciding-record selection, scorer/PlayerStats aggregation, stale-fixture repair |
| `GET /api/scores/historical/{fixtureId}` | replay/coverage probes (finite SSE) |
| `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=[&statKey2=]` | Merkle proof bundles for settlement, receipts, and browser re-verify |

On-chain (txoracle `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`):

- `subscribe` — free-tier data subscription (the activation tx)
- `request_devnet_faucet` — self-serve 100 devnet USDT for any wallet (used by the in-app faucet)
- `validate_stat` — called two ways: **CPI from our pool program** during `resolve` (fund-moving, trustless) and **read-only `.view()` from the user's browser** for independent receipt re-verification
- `daily_scores_roots` PDA (`["daily_scores_roots", u16le epochDay]`) — the root of trust every proof verifies against

## Stack

pnpm monorepo — Anchor program (Rust) · Fastify + SQLite/Drizzle backend (indexer, auto-market engine, AI author, settler, position indexer) on Railway · Vite/React + wallet-adapter SPA on Vercel · Gemini free tier for market authoring (parser of TxLINE data only).

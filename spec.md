# Groundtruth — Verifiable World Cup Prediction Market

*Design specification. Working codename: **Groundtruth** (rename freely). Target: Solana **devnet**. No implementation code and no timelines in this document — this is the architectural contract the build follows.*

---

## 1. One-liner and positioning

**Groundtruth is a minimalist prediction market for the remaining FIFA World Cup 2026 matches where every outcome is settled and *independently re-verifiable* against an on-chain cryptographic proof of the real result — no trusted admin, no "just believe the site."**

The differentiator is not "another betting UI." It is the **receipt**: for every resolved market, anyone can re-check that the winning side was chosen because a specific match statistic (goals, cards, corners, margin) was proven against a Merkle root that TxLINE posted on Solana. The tagline framing:

> *Most prediction markets ask you to trust their oracle. Groundtruth hands you the proof.*

This positioning is deliberate because the whole product sits on top of TxLINE, which already exposes on-chain score-proof validation. Building "yet another AMM" wastes that; building "the market where resolution is provable" uses the one thing TxLINE does that nobody else does.

---

## 2. The single most important design fact

TxLINE's on-chain program (`txoracle`) does **two** things, and the second one is easy to miss:

1. It is a **data oracle**: it posts daily Merkle roots of scores/odds/fixtures on Solana, and serves snapshots + Merkle proofs off-chain so anyone can prove a stat on-chain (`validate_stat` → returns `bool`).
2. It is **already a working P2P prediction-market settlement engine**: it has order intents, matching, escrow vaults, and proof-gated settlement built in (`create_intent`, `execute_match`, `create_trade`, `settle_trade`, `settle_matched_trade`, `claim_via_resolution`, `refund_batch`, `close_intent`), plus a **devnet USDT faucet** (`request_devnet_faucet`).

**Consequence:** the core escrow-and-settlement problem is *solved for us on-chain*. The temptation to write our own USDC-escrow-and-payout program (feature pillar #4 as originally framed) is mostly redundant work that reintroduces risk TxLINE already carries. See §7 for the recommended stance.

---

## 3. What can and cannot be proven on-chain (read this before designing any market)

On-chain score validation only covers **team/match-level aggregate statistics per period**. The provable stat catalog is exactly:

| Base key | Statistic | Base key | Statistic |
|---|---|---|---|
| 1 | Participant 1 total goals | 5 | Participant 1 total red cards |
| 2 | Participant 2 total goals | 6 | Participant 2 total red cards |
| 3 | Participant 1 total yellow cards | 7 | Participant 1 total corners |
| 4 | Participant 2 total yellow cards | 8 | Participant 2 total corners |

Period-scoped keys are `(period * 1000) + base_key` — H1 `+1000`, H2 `+2000`, ET1 `+3000`, ET2 `+4000`, PE `+5000`. Full-game uses the base key.

The validation predicate is expressive but small: prove `stat_a` alone, or `stat_a (op) stat_b`, compared to a threshold.
- **Operators (`BinaryExpression`):** `Add`, `Subtract`.
- **Comparisons:** `GreaterThan`, `LessThan`, `EqualTo`.
- **Negation:** a boolean flag flips the result.

**What this cleanly supports (Class A — chain-verified):**
- Total goals over/under → `(P1 goals Add P2 goals) GreaterThan N`
- Match result / double chance / draw → `(P1 goals Subtract P2 goals) GreaterThan 0` (home win), `EqualTo 0` (draw), etc.
- Team to score / team clean sheet → `P1 goals GreaterThan 0` (+ negation for "fails to score")
- Winning margin bands → subtract + threshold
- Corners over/under, cards over/under → Add on keys 7/8 and 3/4 (or 5/6)
- Period-specific versions of all of the above (e.g. "over 1.5 goals in H1")
- Multi-condition markets (e.g. **Both Teams To Score**) by requiring **two** proofs — `P1 goals > 0` **and** `P2 goals > 0` — combined by our resolver logic. A market's resolution rule is therefore allowed to be a small boolean combination of `validate_stat` checks, not just one.

**What CANNOT be proven this way (do not pretend otherwise):**
- **Player props** — "Mbappé to score", "first goalscorer", "next goal by Brazil". There is **no player-level stat in the on-chain encoding.** Goalscorer identity exists only in the off-chain feed (the `Goal` message's `PlayerId`). These are **Class B — feed-resolved** and must be visibly labeled as such.
- **Tournament / group / bracket outcomes** — "Group A to qualify", "Brazil to win the World Cup". No single proof covers these; they aggregate many fixtures plus deterministic standings/bracket rules. These are **Class C — composed** (see §6).

This three-class split is the spine of the product. The mockup's most eye-catching cards ("Kylian Mbappé to score", "Next goal scored by Brazil") are **Class B**, i.e. the *least* verifiable ones. The demo and the marketing should lead with **Class A**, where the "hand you the proof" claim is literally true, and treat Class B as clearly-flagged fun.

---

## 4. TxLINE integration model (devnet)

Everything below is pinned to **one network**. Mixing devnet/mainnet values breaks activation.

**Devnet constants**
- Program ID: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- TxL mint: `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`
- Devnet USDT mint: `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh`
- RPC: `https://api.devnet.solana.com`
- API host: `https://txline-dev.txodds.com` (guest auth at `/auth/guest/start`, data at `/api/…`)

**Access path (free, no payment).** World Cup + International Friendlies data is free via **service level 1** (documented on devnet; 60-second delay). Flow: guest JWT → on-chain `subscribe(service_level_id=1, weeks=multiple-of-4)` (registers the wallet subscription; no TxL required for free tier) → `/api/token/activate` with the wallet-signed message → use `Authorization: Bearer <jwt>` + `X-Api-Token: <apiToken>` on all data calls. Subscriptions are 28-day multiples; re-subscribe on expiry.

**Data surfaces we consume**
- **Fixtures / Schedule** — the covered match list; drives auto-market generation.
- **Scores snapshot** — `/api/scores/snapshot/{fixtureId}` for state hydration.
- **Scores stream (SSE)** — `/api/scores/stream` for live in-play updates (the action messages: goals, cards, corners, possession/danger, status changes, VAR, etc.).
- **Stat validation** — `/api/scores/stat-validation?fixtureId=&seq=&statKey=[&statKey2=]` returns the snapshot summary + Merkle proofs needed for `validate_stat` and for settlement.
- **Odds stream (optional)** — StablePrice odds SSE, used to seed/label implied probabilities in the Viewer (§10).

**On-chain root anchoring.** Scores roots are posted per **5-minute batch** into a `daily_scores_roots` PDA seeded by `("daily_scores_roots", u16 epoch_day)`. A market can only be *proven/settled after* the batch containing its deciding event (usually full-time) has been rooted on-chain. Settlement latency is therefore inherent (up to ~5 min + posting time). If a root for a slot is missing, on-chain calls fail with `RootNotAvailable` — the market must sit in a "pending root" state, not error out to the user.

---

## 5. Product structure — three sections

The IA matches the minimalist, low-churn brief: one fast surface, one slow surface, one personal surface.

### 5.1 Live
Fast, per-fixture cards for matches currently in play or kicking off soon. This is the "trading floor."

**Card anatomy** (consistent across classes):
- Subject line (e.g. "Over 2.5 — Total goals in this match?", "Both teams to score?").
- **Class badge**: `Chain-verified` (A), `Feed-resolved` (B). This badge is non-negotiable — it is the honesty of the product.
- Live match context: teams, score, minute, status phase.
- Two sides (YES / NO) with current implied price/odds and a live sparkline.
- Volume and participant count.
- Market state chip (Open / Locked / In-play / Awaiting result / Settled).

**Live card sourcing:** the scores SSE stream drives real-time state (score, phase, danger/possession, possible-event flags like `PossibleEvent.Goal`). Class A cards are auto-generated from the provable catalog (§3). Class B player-prop cards are generated from lineup data + the goalscorer feed and flagged.

**Market lock policy:** because free-tier data carries a ~60-second delay, live "next event" markets are dangerous to keep open to the last second. Each market defines a **cutoff rule** (e.g. lock at the start of the deciding phase, or lock N seconds before the tracked event window). Conservative defaults; never let users trade on information the feed hasn't caught up to.

### 5.2 Predictions
Slow, long-horizon markets. Few cards, no frantic churn — the "set it and forget it" surface.
- Group qualification, group winner, top-of-group.
- Knockout progression ("Brazil to reach the semi-final").
- Outright champion.

All of these are **Class C** (composed). Each card states its resolution method plainly ("Resolved from on-chain match proofs + published group table"). See §6 for how Class C stays honest rather than devolving into "trust us."

### 5.3 Profile / Leaderboard
The personal + social surface.
- **Portfolio:** open positions, realized/unrealized P&L, stake at risk, claimable winnings.
- **Receipts wall:** every resolved position links to its verification receipt (§8) with a Solana Explorer link. This is the retention hook — users collect provable wins.
- **Global leaderboard:** ranked by realized P&L (and optionally by "verified accuracy").
- **Following (suggested):** follow other wallets; see their open positions and a feed of their settled receipts. Optional "mirror" affordance that pre-fills a copy of a followed trader's position (user still signs). Keep social read-only + opt-in for the hackathon; copy-trading automation is a stretch.

---

## 6. Market taxonomy and resolution methods

| Class | Examples | How it resolves | Trust model |
|---|---|---|---|
| **A — Chain-verified** | O/U goals, match result, BTTS, team to score, corners O/U, cards O/U, period versions | Off-chain keeper fetches proofs from `/api/scores/stat-validation`; settlement runs through TxLINE's proof-gated `settle_*` path, which re-checks the Merkle proof against the on-chain daily root | **Trustless.** Anyone can re-verify. |
| **B — Feed-resolved** | Player to score, first/next goalscorer, next team to score | Keeper reads the signed feed snapshot (goalscorer `PlayerId`); records the exact snapshot (`fixtureId`, `seq`, `Ts`) as the evidence pointer | **Attested, not proven.** Labeled honestly. Evidence is a feed snapshot reference, not a chain proof. |
| **C — Composed** | Group qualification, bracket, champion | Keeper composes many Class-A per-match proofs, then applies deterministic tournament rules (points, tiebreakers, bracket) to compute the outcome; publishes the derived result (and, as a stretch, anchors a resolution root) | **Proof-backed inputs + transparent public rule.** Each *input* match is chain-verifiable; the aggregation rule is open and deterministic. |

**Design rule:** a market never silently mixes classes. The class badge and the resolution-method string are part of the market definition and are shown on the card and the receipt.

---

## 7. On-chain architecture — recommended stance

There are two viable builds. The recommendation is explicit because the wrong choice doubles the work and the risk.

### Option A (recommended primary) — Orchestrate TxLINE's native market primitives
Do **not** write a custom escrow/payout program. Use the `txoracle` program's built-in market flow:
- **Post a market side** → `create_intent` (maker locks stake in an intent vault, with `terms_hash`, `odds`, `fixture_id`, `expiration_ts`).
- **Take the other side** → matching intents via `execute_match` into a `MatchedTrade` (a solver/keeper pairs compatible intents), or a direct two-party `create_trade`.
- **Settle** → `settle_matched_trade` / `settle_trade`, passing the `ScoresBatchSummary`, the fixture + main-tree proofs, the `StatTerm`(s), predicate, and op. The program itself re-verifies the proof against the on-chain root before paying out. Winner claims; losers' stake routes across.
- **Refund / cancel** → `close_intent`, `refund_batch` for unmatched or unresolvable markets.
- **Terms are canonical**: `MarketIntentParams { fixture_id, period, stat_a_key, stat_b_key?, predicate, op?, negation }` hashed to `terms_hash`. Our off-chain market definition **is** this struct; the hash ties the UI market to the on-chain terms.

Why this is the right default: it *is* deep sponsor-stack leverage (judges reward using the program as intended), it inherits trustless settlement for free, and it removes the largest source of on-chain bugs (custody). The "AMM/escrow" ambition is satisfied by the native intent/match/escrow machinery.

### Option B (optional stretch) — One thin custom Pool program
The mockup's cards imply a **pooled / parimutuel** feel ("$12,430 Vol · 1.2K participants") — many users on one side vs. a pool, not strict 1:1 maker/taker. If that UX is essential, add **exactly one** small custom Anchor program: a parimutuel pool that (a) accepts stakes into a YES-pool and NO-pool for a given `terms_hash`, (b) at resolution performs a **CPI into `validate_stat`** to learn the winning side from the same on-chain root, then (c) distributes the losing pool to winners pro-rata (minus fee). This is the only original on-chain code, and it delivers pillar #4 honestly (own pool contract, but resolution still anchored to TxLINE's proof, not a self-invented oracle).

**Recommendation:** ship Option A as the spine; treat the Option B pool program as a single, well-scoped stretch that unlocks the pooled-card aesthetic. Do **not** build a general AMM curve (LMSR/CPMM) — it adds pricing/complexity risk with no verifiability payoff and competes with, rather than showcases, the TxLINE proof story.

### Stake token
Use the **devnet USDT mint** obtained via the program's `request_devnet_faucet` (nominal, no real value). Minimum deposit is enforced on-chain (`MIN_DEPOSIT_TOKENS`). This keeps the demo self-serve: a judge connects a wallet, faucets test USDT, and trades.

---

## 8. Market lifecycle (state machine)

```
Draft → Open → Locked → In-Play → AwaitingRoot → Resolving → Settled
                         │                                   └→ (Receipt published)
                         └→ Void/Refunded  (on abandonment, missing root, or no-match)
```

- **Draft** — auto-generated from fixture + catalog; not yet tradable.
- **Open** — accepting positions (intents created / pool deposits).
- **Locked** — cutoff reached (§5.1); no new positions. Existing positions stand.
- **In-Play** — deciding events unfolding; live state from SSE.
- **AwaitingRoot** — deciding event has occurred but its 5-minute batch root isn't on-chain yet.
- **Resolving** — keeper has fetched proofs; running `validate_stat` (or composing Class-C inputs) and executing settlement.
- **Settled** — funds distributed; receipt generated.
- **Void/Refunded** — match abandoned/cancelled (status 14/15/16/17/18), root never posted within a bound, or a market never found a counterparty. Stakes returned via `close_intent`/`refund_batch`.

Status transitions are driven by the scores feed's `status` / phase messages (encoding in §3) plus root availability checks.

---

## 9. Resolution and verification pipeline (the receipt)

This is the product's soul. For each Class-A settlement the keeper:
1. Identifies the deciding stat(s) and the `seq` at/after the deciding event.
2. Calls `/api/scores/stat-validation` for the `fixtureId`, `seq`, `statKey` (and `statKey2` for two-stat markets).
3. Assembles: `ScoresBatchSummary` (fixture summary + `events_sub_tree_root`), the fixture proof (`subTreeProof`), the main-tree proof, and the `StatTerm`(s) (`ScoreStat` leaf + `event_stat_root` + stat proof).
4. Executes settlement (`settle_matched_trade`/`settle_trade`, or the pool's `validate_stat` CPI), which **re-verifies the proof against the `daily_scores_roots` PDA on-chain** before moving funds. A failed proof reverts (`PredicateFailed` / `Invalid*Proof` / `RootNotAvailable`).
5. Emits/records the settlement transaction (and, where used, the `AuditVerifiedEvent`: `auditor`, `terms_hash`, `root_used`, `result`, `match_timestamp`, `audit_timestamp`).

**The receipt object** (stored + shown on the card and the profile receipts wall):
- Market terms (human-readable) **and** the `terms_hash`.
- `fixtureId`, deciding `seq`, event timestamp, period.
- The proven `ScoreStat` leaf(s) and predicate/op that decided it.
- The `daily_scores_roots` PDA address and the **root hash used**.
- The settlement / audit transaction signature → **Solana Explorer (devnet) link**.
- A one-line plain-English explanation ("Home win paid out because P1 goals − P2 goals = 2 > 0, proven against the root posted at 21:35 UTC").

**Independent re-verification affordance:** a "Re-verify" button re-runs `validate_stat` as a read-only `.view()` against the same root and shows the boolean, so a skeptic can confirm without trusting our backend. (Keep `.view()` verification separate from fund-moving settlement in the code paths and in the UI copy.)

---

## 10. Automation (the "make it all automatic" requirement)

Four automated services, all off-chain except where they submit transactions.

1. **Auto-market engine.** Polls Fixtures/Schedule; for each covered remaining World Cup match it instantiates the Class-A catalog (and flagged Class-B cards), each pinned to a `MarketIntentParams` terms hash and a lock rule. This is pillar #1 (full-tournament auto-market) across the remaining fixtures. Idempotent: never double-creates a market for the same terms hash.
2. **Live indexer.** Single durable SSE consumer of the scores (and optionally odds) stream. Maintains current fixture state, drives card sparklines/volumes/prices, updates market states, and detects deciding events. Also the source of Class-B evidence snapshots.
3. **Settler / keeper.** Watches for `AwaitingRoot → Resolving` transitions, fetches proofs, submits settlement, generates receipts, and handles the refund/void path when roots don't materialize or matches are abandoned. Backs off and retries on `RootNotAvailable`.
4. **Leaderboard + notifications.** Recomputes rankings on each settlement; pushes "market locked / resolved / you won — here's your receipt" events. Feeds the follow/social surface.

**Suggested additions beyond the brief:**
- **Auto-price seeding** from StablePrice odds so fresh markets don't open at a coin-flip; label as "indicative."
- **Follow-a-trader** graph + a settled-receipts activity feed (opt-in, read-only for v1).
- **"Verified accuracy" stat** per wallet (share of chain-verified wins) — a leaderboard axis no ordinary market can offer, reinforcing the differentiator.
- **Digest/notification** when a followed trader takes a position or a watched market locks.

---

## 11. Off-chain data model (conceptual)

Entities the backend/indexer maintains (fields indicative, not exhaustive):
- **Fixture** — id, competition, participants, start, phase/status, live score, home flag.
- **Market** — id, `fixtureId`, class (A/B/C), human terms, `MarketIntentParams` + `terms_hash`, side prices, volume, participant count, lock rule, state.
- **Position** — wallet, market, side, stake, intent/trade/pool reference, status, payout.
- **ResolutionReceipt** — market, deciding seq/stat, predicate, root PDA + root hash, proof blob reference, settlement tx sig, plain-English line, explorer URL.
- **EvidenceSnapshot** (Class B) — fixtureId, seq, Ts, goalscorer PlayerId, raw feed reference.
- **WalletProfile** — P&L, verified-accuracy, follows, follower feed.

On-chain state (owned by `txoracle`): `OrderIntent`, `MatchedTrade`, `TradeEscrow`, and (Option B) the custom Pool account. We never custody funds in our own backend.

---

## 12. Trust, failure modes, and honest scope (risk register)

The project lives or dies on being *more* honest than a normal book, so failure modes are first-class.

1. **Player props aren't provable.** Mitigation: Class-B badge everywhere; lead the demo with Class-A; never let a Class-B card wear the "chain-verified" look.
2. **60-second data delay (free tier).** Mitigation: conservative market lock cutoffs; no last-second "next goal" trading; state the delay in the UI.
3. **5-minute root cadence → settlement latency.** Mitigation: explicit `AwaitingRoot` state and "pending settlement" UX; never imply instant payout.
4. **Oracle liveness (`RootNotAvailable`).** Mitigation: bounded retry, then void/refund path (`close_intent`/`refund_batch`); surfaced clearly to users.
5. **Match abandonment/cancellation** (status 14–18). Mitigation: auto-void + refund; markets tied to phases that never complete resolve to void, not to a guessed outcome.
6. **BTTS / multi-condition markets** need multiple proofs combined by our logic — a place bugs hide. Mitigation: define each composite market's exact boolean rule in its definition and unit-cover the resolver against known finished fixtures.
7. **Class-C tournament markets are the least trustless.** Mitigation: publish the deterministic rule and every input-match proof; do not over-claim. Consider deferring champion/bracket markets to a stretch.
8. **Redundant-escrow temptation (Option B).** Mitigation: keep any custom program to a single small parimutuel pool that CPIs `validate_stat`; do not reimplement custody or invent an oracle.
9. **Devnet-only.** No real value; the faucet-USDT loop is a feature for judging, not a limitation to hide.

**Explicit non-goals for the hackathon build:** no mainnet/real funds; no general AMM pricing curve; no automated copy-trading execution; no sports beyond soccer; no custom oracle. Everything verifiable routes through TxLINE's proof.

---

## 13. Open questions to close before implementation

- **Option A vs. A+B:** is the pooled-card aesthetic essential enough to justify the one custom Pool program, or is the native intent/match orderbook (with a UI-aggregated "price") sufficient for the demo? (Recommendation: start A-only; add the pool only if time allows.)
- **Matching for Option A:** who runs the `execute_match` solver, and what's the matching policy (odds crossing, partial fills)? A simple keeper-run matcher is probably enough for a demo.
- **Lock-cutoff defaults per market type** given the 60-second delay — needs one concrete rule table.
- **Class-C rule set:** which tournament markets ship (group qualification only, or bracket + champion?), and the exact tiebreak rules used.
- **Proof size / compute limits:** confirm `validate_stat` proof sizes fit within the compute budget for the deepest markets (two-stat, late-game). The `ProofTooLarge` error exists for a reason — verify against a real late-game fixture.
- **Which `settle_*` path** (matched-trade vs. direct trade vs. batch resolution via `publish_resolution_root` + `claim_via_resolution`) best fits the auto-settled UX.

---

## 14. Suggested demo / judging narrative

1. Connect wallet → faucet devnet USDT (self-serve, no signup).
2. Open a **Class-A** live card on a real remaining fixture (e.g. "Over 2.5 goals"). Take a side. Show the position and the on-chain intent/escrow.
3. Fast-forward to full-time (or use a virtual/replay fixture). Watch the market move `Locked → AwaitingRoot → Settled` automatically.
4. Open the **receipt**: show the proven stat, the root hash, the Explorer link, and hit **Re-verify** to re-run `validate_stat` live in front of the judges.
5. Contrast with a **Class-B** card to show the honesty of the labeling — "this one is feed-attested, and we tell you so."
6. Close on the leaderboard's **verified-accuracy** axis: the one metric only a proof-native market can show.

The whole pitch in one sentence: *we didn't build a betting site with an oracle bolted on — we built the market where the oracle's proof is the product.*

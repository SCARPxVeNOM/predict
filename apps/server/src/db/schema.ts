import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Covered fixtures (auto-synced from TxLINE fixtures snapshot). */
export const fixtures = sqliteTable('fixtures', {
  fixtureId: integer('fixture_id').primaryKey(),
  competitionId: integer('competition_id').notNull(),
  competition: text('competition').notNull(),
  homeId: integer('home_id').notNull(),
  home: text('home').notNull(),
  awayId: integer('away_id').notNull(),
  away: text('away').notNull(),
  homeIsP1: integer('home_is_p1', { mode: 'boolean' }).notNull().default(true),
  startTime: integer('start_time').notNull(),
  statusId: integer('status_id'),
  /** Match clock seconds from the latest feed record (in-play only). */
  clockSeconds: integer('clock_seconds'),
  /** Latest Score object (JSON) from the feed. */
  scoreJson: text('score_json'),
  lastSeq: integer('last_seq'),
  lastTs: integer('last_ts'),
  updatedAt: integer('updated_at').notNull(),
});

/** Markets (spec §11); state machine per spec §8. */
export const markets = sqliteTable(
  'markets',
  {
    id: text('id').primaryKey(), // `${fixtureId}:${slug}`
    fixtureId: integer('fixture_id').notNull(),
    slug: text('slug').notNull(),
    marketClass: text('market_class', { enum: ['A', 'B', 'C'] }).notNull(),
    question: text('question').notNull(),
    yesLabel: text('yes_label').notNull(),
    noLabel: text('no_label').notNull(),
    termsJson: text('terms_json').notNull(),
    termsHash: text('terms_hash').notNull(),
    andTermsJson: text('and_terms_json'),
    lockRule: text('lock_rule').notNull(),
    resolutionMethod: text('resolution_method').notNull(),
    state: text('state', {
      enum: ['Draft', 'Open', 'Locked', 'InPlay', 'AwaitingRoot', 'Resolving', 'Settled', 'Void'],
    })
      .notNull()
      .default('Draft'),
    lockTs: integer('lock_ts').notNull(),
    resolveDeadlineTs: integer('resolve_deadline_ts').notNull(),
    /** On-chain pool accounts (null for Class B receipt-only markets). */
    marketPda: text('market_pda'),
    vaultPda: text('vault_pda'),
    createTx: text('create_tx'),
    resolveTx: text('resolve_tx'),
    yesPool: integer('yes_pool').notNull().default(0),
    noPool: integer('no_pool').notNull().default(0),
    participantCount: integer('participant_count').notNull().default(0),
    winnerYes: integer('winner_yes', { mode: 'boolean' }),
    evidenceTs: integer('evidence_ts'),
    disputeUntilTs: integer('dispute_until_ts'),
    /** 'auto' = fixture catalog engine, 'ai' = Gemini-authored tournament market. */
    origin: text('origin').notNull().default('auto'),
    /** AI's one-line reasoning (shown as provenance on tournament cards). */
    rationale: text('rationale'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('markets_fixture_idx').on(t.fixtureId), index('markets_state_idx').on(t.state)],
);

/** Aggregated tournament scorer standings from real per-match PlayerStats. */
export const scorers = sqliteTable('scorers', {
  playerId: integer('player_id').primaryKey(),
  name: text('name'),
  teamId: integer('team_id'),
  team: text('team'),
  goals: integer('goals').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

/** Positions observed on-chain (pool program Position accounts). */
export const positions = sqliteTable(
  'positions',
  {
    id: text('id').primaryKey(), // position PDA
    marketId: text('market_id').notNull(),
    wallet: text('wallet').notNull(),
    sideYes: integer('side_yes', { mode: 'boolean' }).notNull(),
    amount: integer('amount').notNull(), // micro-USDT
    claimed: integer('claimed', { mode: 'boolean' }).notNull().default(false),
    payout: integer('payout'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('positions_wallet_idx').on(t.wallet), index('positions_market_idx').on(t.marketId)],
);

/** Verification receipts (spec §9) — the product's soul. */
export const receipts = sqliteTable('receipts', {
  marketId: text('market_id').primaryKey(),
  fixtureId: integer('fixture_id').notNull(),
  decidingSeq: integer('deciding_seq').notNull(),
  evidenceTs: integer('evidence_ts').notNull(),
  /** Proven ScoreStat leaves + predicate/op, JSON. */
  provenJson: text('proven_json').notNull(),
  rootDay: integer('root_day').notNull(),
  rootPda: text('root_pda').notNull(),
  resolveTx: text('resolve_tx'),
  /** Full proof bundle for browser-side re-verification. */
  proofJson: text('proof_json').notNull(),
  explanation: text('explanation').notNull(),
  winnerYes: integer('winner_yes', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Class-B evidence snapshots (feed-resolved markets). */
export const evidenceSnapshots = sqliteTable('evidence_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  marketId: text('market_id').notNull(),
  fixtureId: integer('fixture_id').notNull(),
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  playerId: integer('player_id'),
  rawJson: text('raw_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const walletProfiles = sqliteTable('wallet_profiles', {
  wallet: text('wallet').primaryKey(),
  realizedPnl: real('realized_pnl').notNull().default(0),
  staked: real('staked').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  /** Wins on chain-verified (Class A) markets only — the honesty metric. */
  verifiedWins: integer('verified_wins').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const follows = sqliteTable('follows', {
  id: text('id').primaryKey(), // `${follower}:${followee}`
  follower: text('follower').notNull(),
  followee: text('followee').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Real implied-price history per market, sampled whenever on-chain pool
 * balances change (positions indexer). Drives card sparklines — no mock data.
 */
export const poolHistory = sqliteTable(
  'pool_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    marketId: text('market_id').notNull(),
    ts: integer('ts').notNull(),
    /** Implied YES probability in basis points (0-10000). */
    impliedYesBps: integer('implied_yes_bps').notNull(),
    volume: integer('volume').notNull(),
  },
  (t) => [index('pool_history_market_idx').on(t.marketId)],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    wallet: text('wallet'), // null = broadcast
    kind: text('kind').notNull(), // market_locked | market_resolved | receipt_ready | claim_ready
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('notifications_wallet_idx').on(t.wallet)],
);

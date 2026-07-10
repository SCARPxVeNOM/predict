import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const dataDir = path.resolve(import.meta.dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(path.join(dataDir, 'groundtruth.db'));
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite, { schema });
export { schema };

/**
 * Dev-friendly bootstrap: create tables if missing (drizzle-kit push without
 * the CLI). Uses IF NOT EXISTS so restarts are safe.
 */
export function migrate(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS fixtures (
      fixture_id INTEGER PRIMARY KEY,
      competition_id INTEGER NOT NULL,
      competition TEXT NOT NULL,
      home_id INTEGER NOT NULL,
      home TEXT NOT NULL,
      away_id INTEGER NOT NULL,
      away TEXT NOT NULL,
      home_is_p1 INTEGER NOT NULL DEFAULT 1,
      start_time INTEGER NOT NULL,
      status_id INTEGER,
      score_json TEXT,
      last_seq INTEGER,
      last_ts INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      fixture_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      market_class TEXT NOT NULL,
      question TEXT NOT NULL,
      yes_label TEXT NOT NULL,
      no_label TEXT NOT NULL,
      terms_json TEXT NOT NULL,
      terms_hash TEXT NOT NULL,
      and_terms_json TEXT,
      lock_rule TEXT NOT NULL,
      resolution_method TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'Draft',
      lock_ts INTEGER NOT NULL,
      resolve_deadline_ts INTEGER NOT NULL,
      market_pda TEXT,
      vault_pda TEXT,
      create_tx TEXT,
      resolve_tx TEXT,
      yes_pool INTEGER NOT NULL DEFAULT 0,
      no_pool INTEGER NOT NULL DEFAULT 0,
      participant_count INTEGER NOT NULL DEFAULT 0,
      winner_yes INTEGER,
      evidence_ts INTEGER,
      dispute_until_ts INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS markets_fixture_idx ON markets(fixture_id);
    CREATE INDEX IF NOT EXISTS markets_state_idx ON markets(state);
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      side_yes INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      claimed INTEGER NOT NULL DEFAULT 0,
      payout INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS positions_wallet_idx ON positions(wallet);
    CREATE INDEX IF NOT EXISTS positions_market_idx ON positions(market_id);
    CREATE TABLE IF NOT EXISTS receipts (
      market_id TEXT PRIMARY KEY,
      fixture_id INTEGER NOT NULL,
      deciding_seq INTEGER NOT NULL,
      evidence_ts INTEGER NOT NULL,
      proven_json TEXT NOT NULL,
      root_day INTEGER NOT NULL,
      root_pda TEXT NOT NULL,
      resolve_tx TEXT,
      proof_json TEXT NOT NULL,
      explanation TEXT NOT NULL,
      winner_yes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      fixture_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      player_id INTEGER,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_profiles (
      wallet TEXT PRIMARY KEY,
      realized_pnl REAL NOT NULL DEFAULT 0,
      staked REAL NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      verified_wins INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      follower TEXT NOT NULL,
      followee TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_wallet_idx ON notifications(wallet);
    CREATE TABLE IF NOT EXISTS pool_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      implied_yes_bps INTEGER NOT NULL,
      volume INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pool_history_market_idx ON pool_history(market_id);
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scorers (
      player_id INTEGER PRIMARY KEY,
      name TEXT,
      team_id INTEGER,
      team TEXT,
      goals INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  // Additive columns for existing databases.
  for (const stmt of [
    'ALTER TABLE fixtures ADD COLUMN clock_seconds INTEGER',
    'ALTER TABLE fixtures ADD COLUMN stats_json TEXT',
    "ALTER TABLE markets ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto'",
    'ALTER TABLE markets ADD COLUMN rationale TEXT',
  ]) {
    try {
      sqlite.exec(stmt);
    } catch {
      /* already present */
    }
  }
}

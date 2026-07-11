import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const root = path.resolve(import.meta.dirname, '../../..');
export const walletsDir = path.join(root, '.wallets');

// Minimal .env loader (repo root) — no dependency needed.
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** World Cup only (user decision 2026-07-10) — competitionId 72 in TxLINE. */
  competitionIds: [72],
  /** How long after scheduled start we allow resolution before voiding (ms). */
  resolveDeadlineMs: 12 * 3600_000,
  keeperKeypairPath: path.join(walletsDir, 'keeper.json'),
  authPath: path.join(walletsDir, 'txline-auth.json'),
  pollFixturesMs: 5 * 60_000,
  pollPositionsMs: 60_000,
  settlerTickMs: 45_000,
  /** Only auto-create markets for fixtures starting within this window. */
  marketHorizonMs: 14 * 86_400_000,
  /** Pause between on-chain market creations (public RPC rate limits). */
  createThrottleMs: 4_000,
  /** Gemini free-tier key for the AI market author (empty = deterministic only). */
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  /** All available keys (GEMINI_API_KEY + GEMINI_API_KEY_2..9) — the client
   * rotates across them because free-tier quotas are per key AND per model. */
  geminiApiKeys: [
    process.env.GEMINI_API_KEY,
    ...Array.from({ length: 8 }, (_, i) => process.env[`GEMINI_API_KEY_${i + 2}`]),
  ].filter((k): k is string => !!k),
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  /** Separate free-tier quota bucket used when the primary model 429s. */
  geminiModelFallback: process.env.GEMINI_MODEL_FALLBACK ?? 'gemini-2.5-flash-lite',
  /** How often the tournament/AI market author runs. */
  aiTickMs: 6 * 3600_000,
  /** How often we check for live matches needing in-play AI markets. */
  liveAiPollMs: 60_000,
};

export function loadKeeper(): Keypair {
  // Deployed environments (no .wallets dir) pass the keypair via env.
  const raw = process.env.KEEPER_SECRET ?? fs.readFileSync(config.keeperKeypairPath, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export interface AuthFile {
  jwt?: string;
  apiToken?: string;
  subscribeTxSig?: string;
}

export function loadAuthFile(): AuthFile {
  if (fs.existsSync(config.authPath)) {
    return JSON.parse(fs.readFileSync(config.authPath, 'utf8')) as AuthFile;
  }
  // Deployed environments seed the TxLINE session via env; refreshes are
  // persisted back to the (ephemeral) file path afterwards.
  if (process.env.TXLINE_AUTH_JSON) return JSON.parse(process.env.TXLINE_AUTH_JSON) as AuthFile;
  return {};
}

export function saveAuthFile(auth: AuthFile): void {
  try {
    fs.mkdirSync(walletsDir, { recursive: true });
    fs.writeFileSync(config.authPath, JSON.stringify(auth, null, 2));
  } catch (err) {
    console.error('[config] could not persist auth file:', String(err).slice(0, 120));
  }
}

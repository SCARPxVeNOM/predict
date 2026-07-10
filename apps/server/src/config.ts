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
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  /** How often the tournament/AI market author runs. */
  aiTickMs: 6 * 3600_000,
};

export function loadKeeper(): Keypair {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(config.keeperKeypairPath, 'utf8')));
  return Keypair.fromSecretKey(secret);
}

export interface AuthFile {
  jwt?: string;
  apiToken?: string;
  subscribeTxSig?: string;
}

export function loadAuthFile(): AuthFile {
  if (!fs.existsSync(config.authPath)) return {};
  return JSON.parse(fs.readFileSync(config.authPath, 'utf8')) as AuthFile;
}

export function saveAuthFile(auth: AuthFile): void {
  fs.mkdirSync(walletsDir, { recursive: true });
  fs.writeFileSync(config.authPath, JSON.stringify(auth, null, 2));
}

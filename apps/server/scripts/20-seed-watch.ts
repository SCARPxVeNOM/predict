/**
 * Live seeding watcher (user request 2026-07-12): during a match window,
 * watch the deployed platform for newly authored markets on the fixture —
 * especially in-play AI specials, which open with a short betting window —
 * and immediately stake both sides from the seed wallets so every new card
 * has real two-sided odds while it is open.
 *
 *   pnpm exec tsx scripts/20-seed-watch.ts <fixtureId> <endIsoTime>
 */
import fs from 'node:fs';
import path from 'node:path';
import { AnchorProvider } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { createPoolProgram, depositTx, USDT_MINT } from '@groundtruth/chain';
import { bootstrap, walletsDir } from './env.js';

const API = 'https://groundtruth-server-production-569f.up.railway.app';
const fixtureId = Number(process.argv[2] ?? 18222446);
const endTime = new Date(process.argv[3] ?? Date.now() + 4 * 3600_000).getTime();
const POLL_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

const { connection } = await bootstrap();
const seeds: Keypair[] = (
  JSON.parse(fs.readFileSync(path.join(walletsDir, 'seeds.json'), 'utf8')) as number[][]
).map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
console.log(`watching fixture ${fixtureId} until ${new Date(endTime).toISOString()} with ${seeds.length} seed wallets`);

async function usdtBalance(owner: PublicKey): Promise<number> {
  try {
    const acc = await getAccount(connection, getAssociatedTokenAddressSync(USDT_MINT, owner));
    return Number(acc.amount);
  } catch {
    return 0;
  }
}

let wi = 0;
async function pickWallet(minUsdt: number): Promise<Keypair | null> {
  for (let i = 0; i < seeds.length; i++) {
    const w = seeds[(wi + i) % seeds.length]!;
    if ((await usdtBalance(w.publicKey)) >= minUsdt) {
      wi = (wi + i + 1) % seeds.length;
      return w;
    }
  }
  return null;
}

async function stake(marketPda: string, sideYes: boolean, amount: number): Promise<boolean> {
  const w = await pickWallet(amount);
  if (!w) {
    console.log('no seed wallet has enough USDT left');
    return false;
  }
  const pool = createPoolProgram(connection, w);
  const tx = await depositTx(pool, w.publicKey, new PublicKey(marketPda), sideYes, amount);
  await (pool.provider as AnchorProvider).sendAndConfirm(tx);
  return true;
}

interface ApiMarket {
  id: string;
  question: string;
  state: string;
  lockTs: number;
  marketPda: string | null;
  yesPool: number;
  noPool: number;
  origin: string;
  fixtureId: number;
}

const handled = new Set<string>();
while (Date.now() < endTime) {
  try {
    const ms = (await (await fetch(`${API}/api/markets?fixtureId=${fixtureId}`)).json()) as ApiMarket[];
    // The API's pool balances lag the chain by up to a minute (position
    // indexer poll) — `handled` prevents double-seeding fresh markets.
    const targets = ms.filter(
      (m) =>
        m.state === 'Open' &&
        m.marketPda &&
        !handled.has(m.id) &&
        m.lockTs > Date.now() + 45_000 &&
        (m.yesPool === 0 || m.noPool === 0),
    );
    for (const m of targets) {
      handled.add(m.id);
      const total = Math.round(rand(4, 10)) * 1_000_000;
      const yesShare = rand(0.35, 0.65);
      const yesAmt = Math.max(1_000_000, Math.round((total * yesShare) / 1e6) * 1_000_000);
      const noAmt = Math.max(1_000_000, total - yesAmt);
      try {
        if (m.yesPool === 0) await stake(m.marketPda!, true, yesAmt);
        await sleep(1200);
        if (m.noPool === 0) await stake(m.marketPda!, false, noAmt);
        console.log(
          `[${new Date().toISOString()}] seeded ${m.origin} market ${m.id} — ${m.question.slice(0, 60)} (${yesAmt / 1e6}/${noAmt / 1e6} USDT)`,
        );
      } catch (err) {
        console.log(`seed failed for ${m.id}: ${String(err).slice(0, 140)}`);
        handled.delete(m.id); // retry next cycle (may be a transient RPC error)
      }
      await sleep(1200);
    }
  } catch (err) {
    console.log(`poll failed: ${String(err).slice(0, 120)}`);
  }
  await sleep(POLL_MS);
}
console.log('watch window ended');

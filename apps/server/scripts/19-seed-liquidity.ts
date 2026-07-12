/**
 * Seed liquidity across the deployed platform (user request 2026-07-11):
 * generate seed wallets, fund them (SOL from keeper, USDT from the TxLINE
 * faucet), and stake BOTH sides of every open pool so cards show real odds
 * and visitors always have a counterparty. Real on-chain volume, visible on
 * the leaderboard by explicit user choice — nothing is hidden.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AnchorProvider } from '@coral-xyz/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import {
  createPoolProgram,
  createProgram,
  depositTx,
  faucetTx,
  USDT_MINT,
} from '@groundtruth/chain';
import { bootstrap, walletsDir } from './env.js';

const API = 'https://groundtruth-server-production-569f.up.railway.app';
const SEEDS_PATH = path.join(walletsDir, 'seeds.json');
const WALLET_COUNT = 12;
const SOL_PER_WALLET = 0.028;
const MAX_MARKETS = 45;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

const { keypair: keeper, connection } = await bootstrap();

// ---- seed wallets ----------------------------------------------------------
let seeds: Keypair[];
if (fs.existsSync(SEEDS_PATH)) {
  seeds = (JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf8')) as number[][]).map((s) =>
    Keypair.fromSecretKey(Uint8Array.from(s)),
  );
  console.log(`loaded ${seeds.length} existing seed wallets`);
} else {
  seeds = Array.from({ length: WALLET_COUNT }, () => Keypair.generate());
  fs.writeFileSync(SEEDS_PATH, JSON.stringify(seeds.map((k) => Array.from(k.secretKey))));
  console.log(`generated ${seeds.length} seed wallets → ${SEEDS_PATH}`);
}

// ---- fund SOL (fees + rent) ------------------------------------------------
for (const s of seeds) {
  const bal = await connection.getBalance(s.publicKey);
  if (bal >= SOL_PER_WALLET * LAMPORTS_PER_SOL * 0.8) continue;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keeper.publicKey,
      toPubkey: s.publicKey,
      lamports: Math.floor(SOL_PER_WALLET * LAMPORTS_PER_SOL),
    }),
  );
  const provider = new AnchorProvider(
    connection,
    { publicKey: keeper.publicKey, signTransaction: async (t: Transaction) => (t.partialSign(keeper), t), signAllTransactions: async (ts: Transaction[]) => ts.map((t) => (t.partialSign(keeper), t)) } as never,
    { commitment: 'confirmed' },
  );
  await provider.sendAndConfirm(tx, []);
  console.log(`funded ${s.publicKey.toBase58().slice(0, 8)} with ${SOL_PER_WALLET} SOL`);
  await sleep(800);
}

// ---- fund USDT (per-wallet faucet) ------------------------------------------
async function usdtBalance(owner: PublicKey): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(USDT_MINT, owner);
    const acc = await getAccount(connection, ata);
    return Number(acc.amount);
  } catch {
    return 0;
  }
}

const budgets = new Map<string, number>();
for (const s of seeds) {
  let bal = await usdtBalance(s.publicKey);
  if (bal < 20_000_000) {
    try {
      const oracle = createProgram(connection, s);
      const { tx } = await faucetTx(connection, oracle, s.publicKey);
      const provider = oracle.provider as AnchorProvider;
      await provider.sendAndConfirm(tx);
      await sleep(800);
      bal = await usdtBalance(s.publicKey);
      console.log(`faucet → ${s.publicKey.toBase58().slice(0, 8)}: ${(bal / 1e6).toFixed(0)} USDT`);
    } catch (err) {
      console.log(`faucet failed for ${s.publicKey.toBase58().slice(0, 8)}: ${String(err).slice(0, 100)}`);
    }
  }
  budgets.set(s.publicKey.toBase58(), bal);
}

// ---- pick markets from the DEPLOYED platform --------------------------------
interface ApiMarket {
  id: string;
  question: string;
  state: string;
  lockTs: number;
  marketPda: string | null;
  yesPool: number;
  noPool: number;
}
const markets = ((await (await fetch(`${API}/api/markets`)).json()) as ApiMarket[])
  .filter((m) => m.state === 'Open' && m.marketPda && m.lockTs > Date.now() + 10 * 60_000)
  .sort((a, b) => a.lockTs - b.lockTs)
  .slice(0, MAX_MARKETS);
console.log(`seeding ${markets.length} open markets`);

// ---- trade both sides --------------------------------------------------------
let totalStaked = 0;
let deposits = 0;
let wi = 0;
const nextWallet = (skip?: string): Keypair => {
  for (let i = 0; i < seeds.length; i++) {
    const w = seeds[(wi + i) % seeds.length]!;
    const key = w.publicKey.toBase58();
    if (key !== skip && (budgets.get(key) ?? 0) >= 2_000_000) {
      wi = (wi + i + 1) % seeds.length;
      return w;
    }
  }
  throw new Error('all seed wallets out of USDT');
};

for (const m of markets) {
  try {
    // Random but sane book: implied YES probability between 30% and 70%,
    // biased to balance whatever one-sided stakes already exist.
    const total = Math.round(rand(4, 12)) * 1_000_000;
    let yesShare = rand(0.3, 0.7);
    if (m.yesPool > m.noPool) yesShare = rand(0.15, 0.4);
    if (m.noPool > m.yesPool) yesShare = rand(0.6, 0.85);
    const yesAmt = Math.max(1_000_000, Math.round((total * yesShare) / 1e6) * 1_000_000);
    const noAmt = Math.max(1_000_000, total - yesAmt);

    for (const [sideYes, amount] of [
      [true, yesAmt],
      [false, noAmt],
    ] as const) {
      const w = nextWallet();
      const budget = budgets.get(w.publicKey.toBase58())!;
      const amt = Math.min(amount, budget);
      if (amt < 1_000_000) continue;
      const pool = createPoolProgram(connection, w);
      const tx = await depositTx(pool, w.publicKey, new PublicKey(m.marketPda!), sideYes, amt);
      const provider = pool.provider as AnchorProvider;
      await provider.sendAndConfirm(tx);
      budgets.set(w.publicKey.toBase58(), budget - amt);
      totalStaked += amt;
      deposits += 1;
      await sleep(1200);
    }
    console.log(`seeded ${m.id} — ${m.question.slice(0, 50)}`);
  } catch (err) {
    console.log(`skip ${m.id}: ${String(err).slice(0, 120)}`);
  }
}

console.log(
  `DONE: ${deposits} deposits, ${(totalStaked / 1e6).toFixed(0)} USDT total volume across ${markets.length} markets`,
);

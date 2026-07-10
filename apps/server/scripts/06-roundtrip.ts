/**
 * M2 gate: full intent → match → settle round-trip on devnet, against the
 * finished fixture Switzerland vs Colombia (18202783, final 0-0).
 *
 * Market: "Total goals > 2.5" → predicate (P1+P2 goals) Add GreaterThan 2.
 * Reality: 0 goals → predicate FALSE → the NO side must be the settling winner.
 *
 * This script also verifies (a) our sha256(borsh(terms)) terms_hash matches the
 * program's, (b) matched_trade PDA seeds, (c) winner semantics.
 */
import BN from 'bn.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DEVNET } from '@groundtruth/shared';
import {
  USDT_MINT,
  createIntent,
  createProgram,
  executeMatch,
  requestDevnetFaucet,
  rootPdaForBundle,
  settleMatchedTrade,
  termsHashHex,
  toStatProofBundle,
  tokenProgramForMint,
  type MarketIntentParams,
} from '@groundtruth/chain';
import { bootstrap, walletsDir } from './env.js';

const FIXTURE_ID = 18202783;
const FINAL_SEQ = 1354;

const { keypair: maker, connection, program, client } = await bootstrap();

// --- taker wallet (persisted separately) --------------------------------
const takerPath = path.join(walletsDir, 'taker.json');
let taker: Keypair;
if (fs.existsSync(takerPath)) {
  taker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(takerPath, 'utf8'))));
} else {
  taker = Keypair.generate();
  fs.writeFileSync(takerPath, JSON.stringify(Array.from(taker.secretKey)));
}
console.log(`Taker: ${taker.publicKey.toBase58()}`);

if ((await connection.getBalance(taker.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: maker.publicKey,
      toPubkey: taker.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [maker], { commitment: 'confirmed' });
  console.log('Funded taker with 0.05 SOL from keeper');
}

const takerProgram = createProgram(connection, taker);
const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
const takerAta = getAssociatedTokenAddressSync(USDT_MINT, taker.publicKey, false, tokenProgram);
if (!(await connection.getAccountInfo(takerAta))) {
  await requestDevnetFaucet(connection, takerProgram, taker);
  console.log('Taker fauceted devnet USDT');
}

const balanceOf = async (ata: ReturnType<typeof getAssociatedTokenAddressSync>) =>
  Number((await getAccount(connection, ata, 'confirmed', tokenProgram)).amount) / 1e6;
const makerAta = getAssociatedTokenAddressSync(USDT_MINT, maker.publicKey, false, tokenProgram);
console.log(`Balances — maker: ${await balanceOf(makerAta)} USDT, taker: ${await balanceOf(takerAta)} USDT`);

// --- market terms --------------------------------------------------------
const terms: MarketIntentParams = {
  fixtureId: new BN(FIXTURE_ID),
  period: 0, // full-game stats
  statAKey: 1, // P1 goals
  statBKey: 2, // P2 goals
  predicate: { threshold: 2, comparison: { greaterThan: {} } },
  op: { add: {} },
  negation: false,
};
console.log(`terms_hash = ${termsHashHex(terms)}`);

const stake = new BN(2_000_000); // 2 USDT each side
const expiration = new BN(Math.floor(Date.now() / 1000) + 24 * 3600);
const runTag = Date.now() % 1_000_000_000;

// --- create both intents --------------------------------------------------
const makerIntent = await createIntent(connection, program, maker, {
  intentId: new BN(runTag),
  terms,
  depositAmount: stake,
  expirationTs: expiration,
  claimPeriod: 30,
});
console.log(`maker intent: ${makerIntent.orderIntent.toBase58()} (${makerIntent.signature})`);

const takerIntent = await createIntent(connection, takerProgram, taker, {
  intentId: new BN(runTag + 1),
  terms,
  depositAmount: stake,
  expirationTs: expiration,
  claimPeriod: 30,
});
console.log(`taker intent: ${takerIntent.orderIntent.toBase58()} (${takerIntent.signature})`);

// --- keeper (maker wallet) as solver matches them --------------------------
const tradeId = new BN(runTag + 2);
const match = await executeMatch(connection, program, maker, {
  tradeId,
  makerIntent: makerIntent.orderIntent,
  takerIntent: takerIntent.orderIntent,
  makerStake: stake,
  takerStake: stake,
});
console.log(`matched trade: ${match.matchedTrade.toBase58()} (${match.signature})`);

// --- proof + settle ---------------------------------------------------------
const val = await client.statValidation(FIXTURE_ID, FINAL_SEQ, 1, 2);
const bundle = toStatProofBundle(val);
const { pda: rootsPda } = rootPdaForBundle(bundle);

// Predicate is FALSE (0 goals ≤ 2) → expect the taker (NO side) to win.
// Try taker first; if the program says WinnerMismatch, try maker — either way
// we learn the winner semantics.
for (const [label, kp, prog] of [
  ['taker', taker, takerProgram] as const,
  ['maker', maker, program] as const,
]) {
  try {
    const sig = await settleMatchedTrade(connection, prog, kp, {
      tradeId,
      matchedTrade: match.matchedTrade,
      bundle,
      terms,
      dailyScoresMerkleRoots: rootsPda,
    });
    console.log(`SETTLED by ${label}: ${DEVNET.explorerTxUrl(sig)}`);
    break;
  } catch (err) {
    console.log(`${label} settle failed: ${String(err).slice(0, 400)}`);
  }
}

console.log(`Balances — maker: ${await balanceOf(makerAta)} USDT, taker: ${await balanceOf(takerAta)} USDT`);

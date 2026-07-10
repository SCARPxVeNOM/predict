/** Place real opposing deposits on a live market before lock (E2E deposit test). */
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { createPoolProgram, depositTx } from '@groundtruth/chain';
import { bootstrap, walletsDir } from './env.js';

const MARKET = new PublicKey(process.argv[2] ?? '98UHu81tFbxoQ9a16dVSE142LsBN7xoHAPg4Kq6xyAPR');
const AMOUNT = Number(process.argv[3] ?? 5) * 1e6;

const { keypair: keeper, connection } = await bootstrap();
const taker = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(walletsDir, 'taker.json'), 'utf8'))),
);

const pool = createPoolProgram(connection, keeper);

for (const [label, kp, sideYes] of [
  ['keeper→YES', keeper, true] as const,
  ['taker→NO', taker, false] as const,
]) {
  const tx = await depositTx(pool, kp.publicKey, MARKET, sideYes, AMOUNT);
  const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });
  console.log(`${label}: ${AMOUNT / 1e6} USDT deposited (${sig})`);
}

const market = await pool.account.market.fetch(MARKET);
console.log(`pools now: YES=${Number(market.yesPool) / 1e6} NO=${Number(market.noPool) / 1e6} state=${JSON.stringify(market.state)}`);

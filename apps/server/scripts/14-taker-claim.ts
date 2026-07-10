/** Winner (taker, NO side) claims stake + pro-rata share of the losing pool. */
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DEVNET } from '@groundtruth/shared';
import { USDT_MINT, claimTx, createPoolProgram, tokenProgramForMint } from '@groundtruth/chain';
import { bootstrap, walletsDir } from './env.js';

const MARKET = new PublicKey(process.argv[2] ?? '98UHu81tFbxoQ9a16dVSE142LsBN7xoHAPg4Kq6xyAPR');

const { connection } = await bootstrap();
const taker = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(walletsDir, 'taker.json'), 'utf8'))),
);
const pool = createPoolProgram(connection, taker);

const market = await pool.account.market.fetch(MARKET);
console.log(
  `market state=${JSON.stringify(market.state)} winnerYes=${market.winnerYes} ` +
    `pools=${Number(market.yesPool) / 1e6}/${Number(market.noPool) / 1e6} ` +
    `disputeUntil=${new Date(Number(market.disputeUntilTs) * 1000).toISOString()} now=${new Date().toISOString()}`,
);

const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
const ata = getAssociatedTokenAddressSync(USDT_MINT, taker.publicKey, false, tokenProgram);
const before = Number((await getAccount(connection, ata, 'confirmed', tokenProgram)).amount) / 1e6;

try {
  const tx = await claimTx(pool, taker.publicKey, MARKET, false);
  const sig = await sendAndConfirmTransaction(connection, tx, [taker], { commitment: 'confirmed' });
  const after = Number((await getAccount(connection, ata, 'confirmed', tokenProgram)).amount) / 1e6;
  console.log(`CLAIMED: ${before} → ${after} USDT (+${after - before})`);
  console.log(DEVNET.explorerTxUrl(sig));
} catch (err) {
  console.log(`claim failed: ${String(err).slice(0, 250)}`);
}

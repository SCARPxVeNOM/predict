/** List all OrderIntent accounts owned by our two wallets (state check). */
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createProgram } from '@groundtruth/chain';
import { bootstrap, walletsDir } from './env.js';

const { keypair: maker, connection, program } = await bootstrap();
const taker = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(walletsDir, 'taker.json'), 'utf8'))),
);

const all = await program.account.orderIntent.all();
console.log(`Total OrderIntent accounts on devnet: ${all.length}`);
for (const { publicKey, account } of all) {
  const mine =
    account.maker.equals(maker.publicKey) ? 'MAKER' :
    account.maker.equals(taker.publicKey) ? 'TAKER' : null;
  if (!mine && all.length > 20) continue;
  console.log(
    `${mine ?? 'other'} ${publicKey.toBase58()} intentId=${account.intentId} ` +
      `fixture=${account.fixtureId} deposit=${account.depositAmount} remaining=${account.remainingAmount} ` +
      `odds=${account.odds} period=${account.period} state=${JSON.stringify(account.state)} ` +
      `hash=${Buffer.from(account.termsHash).toString('hex').slice(0, 16)}…`,
  );
}

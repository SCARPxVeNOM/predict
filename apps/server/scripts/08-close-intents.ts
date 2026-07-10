/** Close our test intents and recover deposits (tests the refund path + who may sign). */
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { closeIntent, createProgram } from '@groundtruth/chain';
import { bootstrap, walletsDir } from './env.js';

const { keypair: maker, connection, program } = await bootstrap();
const taker = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(walletsDir, 'taker.json'), 'utf8'))),
);
const takerProgram = createProgram(connection, taker);

const all = await program.account.orderIntent.all();
for (const { publicKey, account } of all) {
  const owner = account.maker.equals(maker.publicKey)
    ? ({ kp: maker, prog: program, label: 'maker' } as const)
    : account.maker.equals(taker.publicKey)
      ? ({ kp: taker, prog: takerProgram, label: 'taker' } as const)
      : null;
  if (!owner) continue;
  if (!('active' in (account.state as object))) continue;
  try {
    const sig = await closeIntent(connection, owner.prog, owner.kp, account.maker, publicKey);
    console.log(`closed ${publicKey.toBase58()} (${owner.label} self-signed): ${sig}`);
  } catch (err) {
    console.log(`close ${publicKey.toBase58()} failed: ${String(err).slice(0, 200)}`);
  }
}

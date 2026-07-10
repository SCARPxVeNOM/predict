/**
 * If the local Solana CLI wallet (~/.config/solana/id.json) holds devnet SOL,
 * transfer a little to the keeper wallet — workaround for airdrop rate limits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createConnection } from '@groundtruth/chain';
import { loadOrCreateKeypair } from './env.js';

const idPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
const funder = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(idPath, 'utf8'))),
);
const keeper = loadOrCreateKeypair();
const connection = createConnection();

const funderBalance = await connection.getBalance(funder.publicKey);
console.log(`Local CLI wallet ${funder.publicKey.toBase58()}: ${funderBalance / LAMPORTS_PER_SOL} SOL`);

const amount = Number(process.argv[2] ?? 0.2);
if (funderBalance < (amount + 0.01) * LAMPORTS_PER_SOL) {
  throw new Error(`Funder has insufficient devnet SOL (${funderBalance / LAMPORTS_PER_SOL}).`);
}

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: funder.publicKey,
    toPubkey: keeper.publicKey,
    lamports: Math.round(amount * LAMPORTS_PER_SOL),
  }),
);
const sig = await sendAndConfirmTransaction(connection, tx, [funder], { commitment: 'confirmed' });
console.log(`Transferred ${amount} SOL to keeper ${keeper.publicKey.toBase58()}: ${sig}`);
console.log(`Keeper balance: ${(await connection.getBalance(keeper.publicKey)) / LAMPORTS_PER_SOL} SOL`);

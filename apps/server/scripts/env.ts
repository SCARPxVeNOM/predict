/**
 * Shared bootstrap for devnet smoke scripts. Persists the keeper wallet and
 * TxLINE auth state under .wallets/ (gitignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createConnection, createProgram } from '@groundtruth/chain';
import { TxlineClient, TxlineSession, keypairSigner } from '@groundtruth/txline-client';

const here = path.dirname(fileURLToPath(import.meta.url));
export const walletsDir = path.resolve(here, '../../../.wallets');
const keypairPath = path.join(walletsDir, 'keeper.json');
const authPath = path.join(walletsDir, 'txline-auth.json');

export function loadOrCreateKeypair(): Keypair {
  fs.mkdirSync(walletsDir, { recursive: true });
  if (fs.existsSync(keypairPath)) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  fs.writeFileSync(keypairPath, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`Generated new keeper wallet ${kp.publicKey.toBase58()} → ${keypairPath}`);
  return kp;
}

export interface AuthFile {
  jwt?: string;
  apiToken?: string;
  subscribeTxSig?: string;
}

export function loadAuth(): AuthFile {
  if (!fs.existsSync(authPath)) return {};
  return JSON.parse(fs.readFileSync(authPath, 'utf8')) as AuthFile;
}

export function saveAuth(auth: AuthFile): void {
  fs.mkdirSync(walletsDir, { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
}

export async function bootstrap() {
  const keypair = loadOrCreateKeypair();
  const connection = createConnection();
  const program = createProgram(connection, keypair);

  const session = new TxlineSession();
  const saved = loadAuth();
  if (saved.jwt) session.jwt = saved.jwt;
  if (saved.apiToken) session.apiToken = saved.apiToken;
  const client = new TxlineClient(session);

  const sol = (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`Keeper: ${keypair.publicKey.toBase58()} | ${sol.toFixed(4)} SOL`);

  return { keypair, connection, program, session, client, signer: keypairSigner(keypair.secretKey) };
}

export async function ensureSol(minSol = 0.05): Promise<void> {
  const keypair = loadOrCreateKeypair();
  const connection = createConnection();
  const balance = await connection.getBalance(keypair.publicKey);
  if (balance >= minSol * LAMPORTS_PER_SOL) return;
  console.log(`Balance ${balance / LAMPORTS_PER_SOL} SOL < ${minSol}; requesting devnet airdrop...`);

  // The public devnet faucet is aggressively rate-limited; retry with backoff.
  const amounts = [1, 0.5, 0.2, 0.1, 0.1];
  for (let i = 0; i < amounts.length; i++) {
    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, amounts[i]! * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log(`Airdropped ${amounts[i]} SOL: ${sig}`);
      return;
    } catch (err) {
      console.log(`Airdrop attempt ${i + 1} failed: ${String(err).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
    }
  }
  throw new Error(
    `Devnet airdrop rate-limited. Fund ${keypair.publicKey.toBase58()} manually at https://faucet.solana.com (devnet) and re-run.`,
  );
}

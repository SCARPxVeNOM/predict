import { AnchorProvider, Program } from '@coral-xyz/anchor';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { DEVNET } from '@groundtruth/shared';
import {
  claimTx,
  depositTx,
  createPoolProgram,
  poolPositionPda,
  validateStatView,
  toStatProofBundle,
  rootPdaForBundle,
  createProgram,
  type GroundtruthPool,
  type Txoracle,
} from '@groundtruth/chain';
import { Keypair } from '@solana/web3.js';

export const connection = new Connection(DEVNET.rpcUrl, 'confirmed');

/** Pool program bound to the connected wallet (for signing). */
export function poolWith(wallet: AnchorWallet): Program<GroundtruthPool> {
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  // createPoolProgram takes a Keypair; construct directly with provider here.
  const idlProgram = createPoolProgram(connection, Keypair.generate());
  return new Program<GroundtruthPool>(idlProgram.idl, provider);
}

/** Read-only txoracle program for browser-side Re-verify (spec §9). */
export function oracleReadonly(wallet: AnchorWallet): Program<Txoracle> {
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const p = createProgram(connection, Keypair.generate());
  return new Program<Txoracle>(p.idl, provider);
}

export async function sendDeposit(
  wallet: AnchorWallet,
  marketPda: string,
  sideYes: boolean,
  amountUsdt: number,
): Promise<string> {
  const pool = poolWith(wallet);
  const tx: Transaction = await depositTx(
    pool,
    wallet.publicKey,
    new PublicKey(marketPda),
    sideYes,
    Math.round(amountUsdt * 1e6),
  );
  const provider = pool.provider as AnchorProvider;
  return provider.sendAndConfirm(tx);
}

export async function sendClaim(
  wallet: AnchorWallet,
  marketPda: string,
  sideYes: boolean,
): Promise<string> {
  const pool = poolWith(wallet);
  const tx = await claimTx(pool, wallet.publicKey, new PublicKey(marketPda), sideYes);
  const provider = pool.provider as AnchorProvider;
  return provider.sendAndConfirm(tx);
}

/**
 * Browser-side independent re-verification: re-run validate_stat as a
 * read-only view against the same on-chain root and return the boolean.
 */
export async function reverify(
  wallet: AnchorWallet,
  proofJson: string,
  predicate: { threshold: number; comparison: string },
  op: string | null,
): Promise<boolean> {
  const oracle = oracleReadonly(wallet);
  const bundle = toStatProofBundle(JSON.parse(proofJson));
  const cmp =
    predicate.comparison === 'GreaterThan'
      ? { greaterThan: {} }
      : predicate.comparison === 'LessThan'
        ? { lessThan: {} }
        : { equalTo: {} };
  const opArg = op === null ? null : op === 'Add' ? { add: {} } : { subtract: {} };
  return validateStatView(
    oracle,
    bundle,
    { threshold: predicate.threshold, comparison: cmp },
    opArg,
  );
}

export { poolPositionPda, rootPdaForBundle };

import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET } from '@groundtruth/shared';
import type { Txoracle } from './idl/txoracle.js';
import idl from './idl/txoracle.json' with { type: 'json' };

/** Raw IDL for browser callers that must construct Program with their own
 * provider — anchor's browser bundle has no `Wallet` (NodeWallet) export, so
 * the Keypair-based helpers below crash in production web builds. */
export const TXORACLE_IDL = idl;

export const PROGRAM_ID = new PublicKey(DEVNET.programId);
export const TXL_MINT = new PublicKey(DEVNET.txlMint);
export const USDT_MINT = new PublicKey(DEVNET.usdtMint);

export function createConnection(): Connection {
  // SOLANA_RPC_URL lets deployments swap the public devnet RPC (heavily
  // rate-limited from cloud IPs) for a keyed endpoint. Devnet only.
  const url =
    (typeof process !== 'undefined' && process.env?.SOLANA_RPC_URL) || DEVNET.rpcUrl;
  return new Connection(url, 'confirmed');
}

/**
 * Build a typed txoracle Program bound to the given signer.
 * Server-side we always operate with a Keypair (keeper / smoke scripts);
 * the browser builds unsigned txs and lets the wallet adapter sign.
 */
export function createProgram(
  connection: Connection,
  keypair: Keypair,
): anchor.Program<Txoracle> {
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  return new anchor.Program<Txoracle>(idl as unknown as Txoracle, provider);
}

/** Read-only program (fee-payer-less) for `.view()` simulations from the backend. */
export function createReadonlyProgram(connection: Connection): anchor.Program<Txoracle> {
  return createProgram(connection, Keypair.generate());
}

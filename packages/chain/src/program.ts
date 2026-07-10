import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET } from '@groundtruth/shared';
import type { Txoracle } from './idl/txoracle.js';
import idl from './idl/txoracle.json' with { type: 'json' };

export const PROGRAM_ID = new PublicKey(DEVNET.programId);
export const TXL_MINT = new PublicKey(DEVNET.txlMint);
export const USDT_MINT = new PublicKey(DEVNET.usdtMint);

export function createConnection(): Connection {
  return new Connection(DEVNET.rpcUrl, 'confirmed');
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

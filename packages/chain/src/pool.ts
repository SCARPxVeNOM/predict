import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { PlainTerms } from '@groundtruth/shared';
import type { GroundtruthPool } from './idl/groundtruth_pool.js';
import poolIdl from './idl/groundtruth_pool.json' with { type: 'json' };
import { USDT_MINT } from './program.js';
import type { StatProofBundle } from './proofs.js';
import { fromPlainTerms } from './terms.js';

export const POOL_PROGRAM_ID = new PublicKey((poolIdl as { address: string }).address);

const computeIx = () =>
  anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

export function createPoolProgram(
  connection: Connection,
  keypair: Keypair,
): anchor.Program<GroundtruthPool> {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {
    commitment: 'confirmed',
  });
  return new anchor.Program<GroundtruthPool>(poolIdl as unknown as GroundtruthPool, provider);
}

/** Anchor arg shape of the on-chain MarketTerms (borsh-identical to MarketIntentParams). */
export function toPoolTerms(plain: PlainTerms) {
  const t = fromPlainTerms(plain);
  return {
    fixtureId: t.fixtureId,
    period: t.period,
    statAKey: t.statAKey,
    statBKey: t.statBKey,
    predicate: t.predicate,
    op: t.op,
    negation: t.negation,
  };
}

export function poolMarketPdaFromHash(termsHash: number[] | Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('market'), Buffer.from(termsHash)],
    POOL_PROGRAM_ID,
  )[0];
}

export function poolVaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), market.toBuffer()],
    POOL_PROGRAM_ID,
  )[0];
}

export function poolPositionPda(market: PublicKey, owner: PublicKey, sideYes: boolean): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), market.toBuffer(), owner.toBuffer(), Buffer.from([sideYes ? 1 : 0])],
    POOL_PROGRAM_ID,
  )[0];
}

import { termsHash } from './terms.js';

/** Market PDA for the given plain terms. */
export function marketPda(terms: ReturnType<typeof fromPlainTerms>): PublicKey {
  return poolMarketPdaFromHash(termsHash(terms));
}
export function vaultPda(market: PublicKey): PublicKey {
  return poolVaultPda(market);
}

export async function createMarket(
  pool: anchor.Program<GroundtruthPool>,
  creator: Keypair,
  plain: PlainTerms,
  times: { lockTs: number; resolveDeadlineTs: number },
): Promise<{ signature: string; market: PublicKey; vault: PublicKey }> {
  const terms = toPoolTerms(plain);
  const market = marketPda(fromPlainTerms(plain));
  const vault = poolVaultPda(market);
  const signature = await pool.methods
    .createMarket(terms, new BN(times.lockTs), new BN(times.resolveDeadlineTs))
    .accountsPartial({
      creator: creator.publicKey,
      market,
      vault,
      usdtMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator])
    .rpc();
  return { signature, market, vault };
}

/** User-signed deposit (also used by the web app via wallet adapter). */
export async function depositTx(
  pool: anchor.Program<GroundtruthPool>,
  user: PublicKey,
  market: PublicKey,
  sideYes: boolean,
  amountMicroUsdt: number,
) {
  return pool.methods
    .deposit(sideYes, new BN(amountMicroUsdt))
    .accountsPartial({
      user,
      market,
      vault: poolVaultPda(market),
      userToken: getAssociatedTokenAddressSync(USDT_MINT, user, false, TOKEN_PROGRAM_ID),
      position: poolPositionPda(market, user, sideYes),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
}

/** Permissionless proof-backed resolution (keeper-cranked). */
export async function resolveMarket(
  pool: anchor.Program<GroundtruthPool>,
  resolver: Keypair,
  marketPdaStr: string | PublicKey,
  bundle: StatProofBundle,
  dailyScoresMerkleRoots: PublicKey,
): Promise<string> {
  const market = new PublicKey(marketPdaStr);
  return pool.methods
    .resolve(
      bundle.ts,
      bundle.fixtureSummary,
      bundle.fixtureProof,
      bundle.mainTreeProof,
      bundle.statA,
      bundle.statB,
    )
    .accountsPartial({
      resolver: resolver.publicKey,
      market,
      dailyScoresMerkleRoots,
      txoracleProgram: new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J'),
    })
    .preInstructions([computeIx()])
    .signers([resolver])
    .rpc();
}

export async function voidMarketOnChain(
  pool: anchor.Program<GroundtruthPool>,
  caller: Keypair,
  marketPdaStr: string | PublicKey,
): Promise<string> {
  return pool.methods
    .voidMarket()
    .accountsPartial({ caller: caller.publicKey, market: new PublicKey(marketPdaStr) })
    .signers([caller])
    .rpc();
}

/** User-signed claim transaction (built server- or client-side). */
export async function claimTx(
  pool: anchor.Program<GroundtruthPool>,
  user: PublicKey,
  market: PublicKey,
  sideYes: boolean,
) {
  return pool.methods
    .claim()
    .accountsPartial({
      user,
      market,
      position: poolPositionPda(market, user, sideYes),
      vault: poolVaultPda(market),
      userToken: getAssociatedTokenAddressSync(USDT_MINT, user, false, TOKEN_PROGRAM_ID),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .transaction();
}

export type { GroundtruthPool };

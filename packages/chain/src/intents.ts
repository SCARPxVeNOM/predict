import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Txoracle } from './idl/txoracle.js';
import { PROGRAM_ID, USDT_MINT } from './program.js';
import {
  intentVaultPda,
  matchedTradePdaCandidates,
  orderIntentPda,
  tokenTreasuryPda,
  tradeVaultPda,
} from './pdas.js';
import { tokenProgramForMint } from './faucet.js';
import type { StatProofBundle } from './proofs.js';
import type { MarketIntentParams } from './terms.js';
import { termsHash } from './terms.js';

const COMPUTE_UNITS = 1_400_000;
const computeIx = () =>
  anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS });

export interface CreateIntentParams {
  intentId: BN;
  terms: MarketIntentParams;
  depositAmount: BN;
  expirationTs: BN;
  /** Claim window (u16) passed through to the program. */
  claimPeriod: number;
}

/** Maker locks stake in an intent vault. Returns tx sig + the intent PDA. */
export async function createIntent(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  maker: Keypair,
  p: CreateIntentParams,
): Promise<{ signature: string; orderIntent: PublicKey }> {
  const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
  const orderIntent = orderIntentPda(maker.publicKey, BigInt(p.intentId.toString()));
  const signature = await program.methods
    .createIntent(
      p.intentId,
      termsHash(p.terms),
      p.depositAmount,
      p.expirationTs,
      p.claimPeriod,
      p.terms.fixtureId,
    )
    .accounts({
      maker: maker.publicKey,
      orderIntent,
      intentVault: intentVaultPda(orderIntent),
      makerTokenAccount: getAssociatedTokenAddressSync(
        USDT_MINT,
        maker.publicKey,
        false,
        tokenProgram,
      ),
      tokenMint: USDT_MINT,
      tokenTreasuryPda: tokenTreasuryPda(),
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .signers([maker])
    .rpc();
  return { signature, orderIntent };
}

/** Extract the program-expected PDA from a ConstraintSeeds AnchorError. */
function expectedPdaFromError(err: unknown): { account: string; expected: PublicKey } | null {
  const anchorErr = err as {
    error?: { errorCode?: { code?: string }; origin?: string; comparedValues?: unknown[] };
  };
  if (anchorErr?.error?.errorCode?.code !== 'ConstraintSeeds') return null;
  const compared = anchorErr.error.comparedValues;
  const expected = compared?.[1];
  if (!(expected instanceof PublicKey)) return null;
  return { account: String(anchorErr.error.origin ?? ''), expected };
}

/** Search prefix × component permutations (≤3) for seeds deriving `target`. */
function crackSeeds(
  target: PublicKey,
  prefixes: string[],
  components: Record<string, Buffer>,
): Buffer[] | null {
  const names = Object.keys(components);
  const perms: string[][] = [[]];
  for (const a of names) {
    perms.push([a]);
    for (const b of names) {
      if (b === a) continue;
      perms.push([a, b]);
      for (const c of names) {
        if (c === a || c === b) continue;
        perms.push([a, b, c]);
      }
    }
  }
  for (const prefix of prefixes) {
    for (const combo of perms) {
      const seeds = [
        ...(prefix ? [Buffer.from(prefix)] : []),
        ...combo.map((n) => components[n]!),
      ];
      if (!seeds.length) continue;
      try {
        const [derived] = PublicKey.findProgramAddressSync(seeds, program_id());
        if (derived.equals(target)) return seeds;
      } catch {
        continue; // seeds exceed max length
      }
    }
  }
  return null;
}

const program_id = () => PROGRAM_ID;

/**
 * Solver pairs two opposing intents into a MatchedTrade. On a seeds-constraint
 * failure the expected PDA from the program logs is cracked against a wide
 * candidate space and the call retried — the resolved derivation is logged so
 * it can be pinned in pdas.ts.
 */
export async function executeMatch(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  solver: Keypair,
  args: {
    tradeId: BN;
    makerIntent: PublicKey;
    takerIntent: PublicKey;
    makerStake: BN;
    takerStake: BN;
  },
): Promise<{ signature: string; matchedTrade: PublicKey }> {
  const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
  const idLe = args.tradeId.toArrayLike(Buffer, 'le', 8);

  let matchedTrade = matchedTradePdaCandidates(BigInt(args.tradeId.toString()))[0]!;
  let tradeVault = tradeVaultPda(matchedTrade);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const signature = await program.methods
        .executeMatch(args.tradeId, args.makerStake, args.takerStake)
        .accounts({
          solver: solver.publicKey,
          makerIntent: args.makerIntent,
          takerIntent: args.takerIntent,
          makerVault: intentVaultPda(args.makerIntent),
          takerVault: intentVaultPda(args.takerIntent),
          matchedTrade,
          tradeVault,
          tokenMint: USDT_MINT,
          tokenProgram,
          systemProgram: SystemProgram.programId,
        })
        .signers([solver])
        .rpc();
      return { signature, matchedTrade };
    } catch (err) {
      const info = expectedPdaFromError(err);
      if (!info) throw err;
      const components: Record<string, Buffer> = {
        tradeId: idLe,
        makerIntent: args.makerIntent.toBuffer(),
        takerIntent: args.takerIntent.toBuffer(),
        solver: solver.publicKey.toBuffer(),
        matchedTrade: matchedTrade.toBuffer(),
      };
      const prefixes = [
        '', 'matched_trade', 'trade', 'match', 'mt', 'matched', 'trade_vault',
        'vault', 'escrow', 'escrow_vault', 'matched_vault',
      ];
      const seeds = crackSeeds(info.expected, prefixes, components);
      if (!seeds) throw err;
      const seedDesc = seeds
        .map((s) =>
          s.length <= 16 ? JSON.stringify(s.toString()) : s.equals(idLe) ? 'tradeIdLe' : 'pubkey(32)',
        )
        .join(', ');
      console.log(`[executeMatch] resolved ${info.account} seeds = [${seedDesc}] → ${info.expected.toBase58()}`);
      if (info.account === 'matched_trade') {
        matchedTrade = info.expected;
        tradeVault = tradeVaultPda(matchedTrade);
      } else if (info.account === 'trade_vault') {
        tradeVault = info.expected;
      } else {
        throw err;
      }
    }
  }
  throw new Error('executeMatch: exhausted seed resolution attempts');
}

/**
 * Winner-signed settlement of a matched trade: submits the Merkle proof bundle
 * and the cleartext terms; the program re-verifies everything on-chain and
 * pays the combined stake to the winner.
 */
export async function settleMatchedTrade(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  winner: Keypair,
  args: {
    tradeId: BN;
    matchedTrade: PublicKey;
    bundle: StatProofBundle;
    terms: MarketIntentParams;
    dailyScoresMerkleRoots: PublicKey;
  },
): Promise<string> {
  const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
  return program.methods
    .settleMatchedTrade(
      args.tradeId,
      args.bundle.ts,
      args.bundle.fixtureSummary,
      args.bundle.fixtureProof,
      args.bundle.mainTreeProof,
      args.bundle.statA,
      args.bundle.statB,
      args.terms,
    )
    .accounts({
      winner: winner.publicKey,
      dailyScoresMerkleRoots: args.dailyScoresMerkleRoots,
      matchedTrade: args.matchedTrade,
      tradeVault: tradeVaultPda(args.matchedTrade),
      winnerTokenAccount: getAssociatedTokenAddressSync(
        USDT_MINT,
        winner.publicKey,
        false,
        tokenProgram,
      ),
      tokenMint: USDT_MINT,
      tokenTreasuryPda: tokenTreasuryPda(),
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeIx()])
    .signers([winner])
    .rpc();
}

/** Maker cancels an unmatched intent and recovers the deposit. */
export async function closeIntent(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  authority: Keypair,
  maker: PublicKey,
  orderIntent: PublicKey,
): Promise<string> {
  const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
  return program.methods
    .closeIntent()
    .accounts({
      maker,
      authority: authority.publicKey,
      orderIntent,
      intentVault: intentVaultPda(orderIntent),
      makerTokenAccount: getAssociatedTokenAddressSync(USDT_MINT, maker, false, tokenProgram),
      tokenMint: USDT_MINT,
      tokenProgram,
      tokenTreasuryPda: tokenTreasuryPda(),
    })
    .signers([authority])
    .rpc();
}

import * as anchor from '@coral-xyz/anchor';
import { epochDay } from '@groundtruth/shared';
import type { Txoracle } from './idl/txoracle.js';
import { dailyScoresRootsPda } from './pdas.js';
import type {
  BinaryExpressionArg,
  StatProofBundle,
  TraderPredicateArg,
} from './proofs.js';

const COMPUTE_UNITS = 1_400_000;

const computeBudgetIx = () =>
  anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS });

/**
 * Read-only on-chain validation of a 1–2 stat predicate against the posted
 * daily scores root. This is the "Re-verify" primitive (spec §9) — strictly
 * separate from any fund-moving settlement path.
 *
 * Returns the on-chain boolean; throws if the proof itself is invalid or the
 * root is not yet available (RootNotAvailable).
 */
export async function validateStatView(
  program: anchor.Program<Txoracle>,
  bundle: StatProofBundle,
  predicate: TraderPredicateArg,
  op: BinaryExpressionArg | null,
): Promise<boolean> {
  const day = epochDay(bundle.ts.toNumber());
  return program.methods
    .validateStat(
      bundle.ts,
      bundle.fixtureSummary,
      bundle.fixtureProof,
      bundle.mainTreeProof,
      predicate,
      bundle.statA,
      bundle.statB,
      op,
    )
    .accounts({ dailyScoresMerkleRoots: dailyScoresRootsPda(day) })
    .preInstructions([computeBudgetIx()])
    .view();
}

/** The batch-root PDA + day used for a given proof bundle (for receipts). */
export function rootPdaForBundle(bundle: StatProofBundle) {
  const day = epochDay(bundle.ts.toNumber());
  return { epochDay: day, pda: dailyScoresRootsPda(day) };
}

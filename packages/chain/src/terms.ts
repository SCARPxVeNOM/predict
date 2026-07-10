import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { sha256 } from '@noble/hashes/sha2';
import type { BinaryExpressionArg, TraderPredicateArg } from './proofs.js';
import idl from './idl/txoracle.json' with { type: 'json' };

/**
 * Canonical market terms — this struct IS the market definition (spec §7).
 * Hashed to terms_hash, which ties the UI market to the on-chain intent.
 */
export interface MarketIntentParams {
  fixtureId: BN;
  /** Stat period scope of the prediction (game-phase id per feed encoding). */
  period: number;
  statAKey: number;
  statBKey: number | null;
  predicate: TraderPredicateArg;
  op: BinaryExpressionArg | null;
  negation: boolean;
}

// Program instances camelCase the IDL before building coders; do the same so
// enum variants like { greaterThan: {} } encode identically here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl.js';

const typesCoder = new anchor.BorshCoder(convertIdlToCamelCase(idl as anchor.Idl)).types;

/** Borsh-serialize MarketIntentParams exactly as the on-chain program does. */
export function encodeMarketIntentParams(params: MarketIntentParams): Buffer {
  return typesCoder.encode('marketIntentParams', params);
}

/**
 * terms_hash = sha256(borsh(MarketIntentParams)).
 * The program recomputes this hash from the `terms` arg at settlement and
 * rejects on mismatch (TermsMismatch), which is how this encoding is verified
 * end-to-end in the M2 round-trip script.
 */
export function termsHash(params: MarketIntentParams): number[] {
  return Array.from(sha256(encodeMarketIntentParams(params)));
}

export function termsHashHex(params: MarketIntentParams): string {
  return Buffer.from(termsHash(params)).toString('hex');
}

/** Convert the shared plain-JSON terms into Anchor arg shapes. */
export function fromPlainTerms(plain: {
  fixtureId: number;
  period: number;
  statAKey: number;
  statBKey: number | null;
  predicate: { threshold: number; comparison: 'GreaterThan' | 'LessThan' | 'EqualTo' };
  op: 'Add' | 'Subtract' | null;
  negation: boolean;
}): MarketIntentParams {
  const comparison =
    plain.predicate.comparison === 'GreaterThan'
      ? { greaterThan: {} }
      : plain.predicate.comparison === 'LessThan'
        ? { lessThan: {} }
        : { equalTo: {} };
  return {
    fixtureId: new BN(plain.fixtureId),
    period: plain.period,
    statAKey: plain.statAKey,
    statBKey: plain.statBKey,
    predicate: { threshold: plain.predicate.threshold, comparison },
    op: plain.op === null ? null : plain.op === 'Add' ? { add: {} } : { subtract: {} },
    negation: plain.negation,
  };
}

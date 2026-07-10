/**
 * Plain-JSON market terms — the canonical, serializable market definition
 * shared by catalog, backend, and frontend. The chain package converts this
 * to Anchor arg shapes (BN + enum objects) and hashes it (terms_hash).
 */

export type ComparisonName = 'GreaterThan' | 'LessThan' | 'EqualTo';
export type BinaryOpName = 'Add' | 'Subtract';

export interface PlainTerms {
  fixtureId: number;
  /** Stat period scope (0 = full game; 1000-offset per period). */
  period: number;
  statAKey: number;
  statBKey: number | null;
  predicate: { threshold: number; comparison: ComparisonName };
  op: BinaryOpName | null;
  negation: boolean;
}

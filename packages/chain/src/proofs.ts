import BN from 'bn.js';

/** API-side shapes (subset — see @groundtruth/txline-client types). */
interface ApiProofNode {
  hash: number[] | Uint8Array;
  isRightSibling: boolean;
}
interface ApiScoreStat {
  key: number;
  value: number;
  period: number;
}
interface ApiSummary {
  fixtureId: number;
  updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
  eventStatsSubTreeRoot: number[] | Uint8Array;
}

/** Anchor-side arg shapes (camelCase, BN for 64-bit ints, number[] for byte arrays). */
export interface ProofNodeArg {
  hash: number[];
  isRightSibling: boolean;
}
export interface StatTermArg {
  statToProve: ApiScoreStat;
  eventStatRoot: number[];
  statProof: ProofNodeArg[];
}
export interface SummaryArg {
  fixtureId: BN;
  updateStats: { updateCount: number; minTimestamp: BN; maxTimestamp: BN };
  eventsSubTreeRoot: number[];
}
export type ComparisonArg = { greaterThan: {} } | { lessThan: {} } | { equalTo: {} };
export interface TraderPredicateArg {
  threshold: number;
  comparison: ComparisonArg;
}
export type BinaryExpressionArg = { add: {} } | { subtract: {} };

export const toProofNodes = (proof: ApiProofNode[]): ProofNodeArg[] =>
  proof.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));

export const toSummaryArg = (summary: ApiSummary): SummaryArg => ({
  fixtureId: new BN(summary.fixtureId),
  updateStats: {
    updateCount: summary.updateStats.updateCount,
    minTimestamp: new BN(summary.updateStats.minTimestamp),
    maxTimestamp: new BN(summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: Array.from(summary.eventStatsSubTreeRoot),
});

export const toStatTermArg = (
  statToProve: ApiScoreStat,
  eventStatRoot: number[] | Uint8Array,
  statProof: ApiProofNode[],
): StatTermArg => ({
  statToProve,
  eventStatRoot: Array.from(eventStatRoot),
  statProof: toProofNodes(statProof),
});

/**
 * Complete argument bundle for validate_stat / settle_* built from one
 * legacy stat-validation API response.
 */
export interface StatProofBundle {
  ts: BN;
  fixtureSummary: SummaryArg;
  fixtureProof: ProofNodeArg[];
  mainTreeProof: ProofNodeArg[];
  statA: StatTermArg;
  statB: StatTermArg | null;
}

export function toStatProofBundle(val: {
  ts: number;
  statToProve: ApiScoreStat;
  eventStatRoot: number[];
  summary: ApiSummary;
  statProof: ApiProofNode[];
  subTreeProof: ApiProofNode[];
  mainTreeProof: ApiProofNode[];
  statToProve2?: ApiScoreStat;
  statProof2?: ApiProofNode[];
}): StatProofBundle {
  return {
    ts: new BN(val.ts),
    fixtureSummary: toSummaryArg(val.summary),
    fixtureProof: toProofNodes(val.subTreeProof),
    mainTreeProof: toProofNodes(val.mainTreeProof),
    statA: toStatTermArg(val.statToProve, val.eventStatRoot, val.statProof),
    statB:
      val.statToProve2 && val.statProof2
        ? toStatTermArg(val.statToProve2, val.eventStatRoot, val.statProof2)
        : null,
  };
}

import type { PlainTerms } from '@groundtruth/shared';
import { STAT, statKey, type StatPeriod } from './stats.js';

/**
 * A market definition instantiated for a fixture. Class A markets are decided
 * by a single on-chain provable predicate (PlainTerms). Composite markets
 * (e.g. BTTS) combine TWO provable predicates with an AND — each leg is
 * chain-verified, the combination rule is public (spec §3).
 */
export interface MarketDef {
  /** Stable slug unique per fixture, e.g. "ou-goals-2.5". */
  slug: string;
  marketClass: 'A' | 'B';
  /** Card subject line. */
  question: string;
  yesLabel: string;
  noLabel: string;
  /** Primary predicate (drives the on-chain pool). */
  terms: PlainTerms;
  /**
   * Extra predicates ANDed with `terms` for composite markets. v1 pools carry
   * only single-predicate markets on-chain; composites stay receipt-only.
   */
  andTerms?: PlainTerms[];
  /** Lock rule key (see locks.ts). */
  lockRule: LockRuleName;
  /** Human resolution-method string shown on card + receipt. */
  resolutionMethod: string;
}

export type LockRuleName = 'kickoff' | 'periodStart' | 'never-inplay';

const CHAIN_METHOD =
  'Settled on-chain: Merkle proof of the match stat verified against the TxLINE daily scores root';

function base(
  fixtureId: number,
  slug: string,
  question: string,
  terms: Omit<PlainTerms, 'fixtureId'>,
  opts?: Partial<Pick<MarketDef, 'yesLabel' | 'noLabel' | 'lockRule' | 'andTerms'>>,
): MarketDef {
  return {
    slug,
    marketClass: 'A',
    question,
    yesLabel: opts?.yesLabel ?? 'YES',
    noLabel: opts?.noLabel ?? 'NO',
    terms: { fixtureId, ...terms },
    andTerms: opts?.andTerms,
    lockRule: opts?.lockRule ?? 'kickoff',
    resolutionMethod: CHAIN_METHOD,
  };
}

export interface FixtureInfo {
  fixtureId: number;
  home: string;
  away: string;
}

/**
 * Instantiate the Class-A catalog for one fixture. `lines` allows tuning O/U
 * thresholds; defaults follow common soccer lines.
 */
export function classAMarkets(fx: FixtureInfo, period: StatPeriod = 0): MarketDef[] {
  const p = period;
  const tag = p === 0 ? '' : p === 1 ? ' (1st half)' : ' (2nd half)';
  const suffix = p === 0 ? '' : `-p${p}`;
  const defs: MarketDef[] = [];

  // Over/Under total goals — X.5 lines expressed as "> X".
  for (const line of p === 0 ? [1.5, 2.5, 3.5] : [0.5, 1.5]) {
    defs.push(
      base(
        fx.fixtureId,
        `ou-goals-${line}${suffix}`,
        `Over ${line} total goals${tag}?`,
        {
          period: p,
          statAKey: statKey(STAT.P1_GOALS, p),
          statBKey: statKey(STAT.P2_GOALS, p),
          predicate: { threshold: Math.floor(line), comparison: 'GreaterThan' },
          op: 'Add',
          negation: false,
        },
        { yesLabel: `Over ${line}`, noLabel: `Under ${line}` },
      ),
    );
  }

  if (p === 0) {
    // Match result (draw-no-bet style pair + draw itself).
    defs.push(
      base(fx.fixtureId, 'home-win', `${fx.home} to win (90'/ET/pens count regulation stats)?`, {
        period: 0,
        statAKey: STAT.P1_GOALS,
        statBKey: STAT.P2_GOALS,
        predicate: { threshold: 0, comparison: 'GreaterThan' },
        op: 'Subtract',
        negation: false,
      }),
      base(fx.fixtureId, 'away-win', `${fx.away} to win?`, {
        period: 0,
        statAKey: STAT.P2_GOALS,
        statBKey: STAT.P1_GOALS,
        predicate: { threshold: 0, comparison: 'GreaterThan' },
        op: 'Subtract',
        negation: false,
      }),
      base(fx.fixtureId, 'draw', 'Match drawn (full-game goals level)?', {
        period: 0,
        statAKey: STAT.P1_GOALS,
        statBKey: STAT.P2_GOALS,
        predicate: { threshold: 0, comparison: 'EqualTo' },
        op: 'Subtract',
        negation: false,
      }),
      // Team to score / clean sheets.
      base(fx.fixtureId, 'home-scores', `${fx.home} to score?`, {
        period: 0,
        statAKey: STAT.P1_GOALS,
        statBKey: null,
        predicate: { threshold: 0, comparison: 'GreaterThan' },
        op: null,
        negation: false,
      }),
      base(fx.fixtureId, 'away-scores', `${fx.away} to score?`, {
        period: 0,
        statAKey: STAT.P2_GOALS,
        statBKey: null,
        predicate: { threshold: 0, comparison: 'GreaterThan' },
        op: null,
        negation: false,
      }),
      // Winning margins (2+ goals) — subtract + threshold (spec §3).
      base(fx.fixtureId, 'home-wins-by-2', `${fx.home} to win by 2+ goals?`, {
        period: 0,
        statAKey: STAT.P1_GOALS,
        statBKey: STAT.P2_GOALS,
        predicate: { threshold: 1, comparison: 'GreaterThan' },
        op: 'Subtract',
        negation: false,
      }),
      base(fx.fixtureId, 'away-wins-by-2', `${fx.away} to win by 2+ goals?`, {
        period: 0,
        statAKey: STAT.P2_GOALS,
        statBKey: STAT.P1_GOALS,
        predicate: { threshold: 1, comparison: 'GreaterThan' },
        op: 'Subtract',
        negation: false,
      }),
      // Corners and cards O/U.
      base(fx.fixtureId, 'ou-corners-8.5', 'Over 8.5 total corners?', {
        period: 0,
        statAKey: STAT.P1_CORNERS,
        statBKey: STAT.P2_CORNERS,
        predicate: { threshold: 8, comparison: 'GreaterThan' },
        op: 'Add',
        negation: false,
      }),
      base(fx.fixtureId, 'ou-corners-10.5', 'Over 10.5 total corners?', {
        period: 0,
        statAKey: STAT.P1_CORNERS,
        statBKey: STAT.P2_CORNERS,
        predicate: { threshold: 10, comparison: 'GreaterThan' },
        op: 'Add',
        negation: false,
      }),
      base(fx.fixtureId, 'home-most-corners', `${fx.home} to win the corner count?`, {
        period: 0,
        statAKey: STAT.P1_CORNERS,
        statBKey: STAT.P2_CORNERS,
        predicate: { threshold: 0, comparison: 'GreaterThan' },
        op: 'Subtract',
        negation: false,
      }),
      base(fx.fixtureId, 'ou-yellows-3.5', 'Over 3.5 yellow cards?', {
        period: 0,
        statAKey: STAT.P1_YELLOW,
        statBKey: STAT.P2_YELLOW,
        predicate: { threshold: 3, comparison: 'GreaterThan' },
        op: 'Add',
        negation: false,
      }),
      base(fx.fixtureId, 'red-card', 'A red card shown?', {
        period: 0,
        statAKey: STAT.P1_RED,
        statBKey: STAT.P2_RED,
        predicate: { threshold: 0, comparison: 'GreaterThan' },
        op: 'Add',
        negation: false,
      }),
      // BTTS — composite: two single-stat proofs ANDed (receipt-only in v1).
      {
        ...base(fx.fixtureId, 'btts', 'Both teams to score?', {
          period: 0,
          statAKey: STAT.P1_GOALS,
          statBKey: null,
          predicate: { threshold: 0, comparison: 'GreaterThan' },
          op: null,
          negation: false,
        }),
        andTerms: [
          {
            fixtureId: fx.fixtureId,
            period: 0,
            statAKey: STAT.P2_GOALS,
            statBKey: null,
            predicate: { threshold: 0, comparison: 'GreaterThan' },
            op: null,
            negation: false,
          },
        ],
        resolutionMethod: `${CHAIN_METHOD}; composite of two proofs (home goals > 0 AND away goals > 0), combination rule public`,
      },
    );
  }
  return defs;
}

/** Class B (feed-resolved) template — flagged, never chain-verified. */
export interface ClassBDef {
  slug: string;
  marketClass: 'B';
  question: string;
  playerId?: number;
  resolutionMethod: string;
}

export function playerToScore(playerName: string, playerId: number): ClassBDef {
  return {
    slug: `player-scores-${playerId}`,
    marketClass: 'B',
    question: `${playerName} to score?`,
    playerId,
    resolutionMethod:
      'Feed-resolved: decided from the TxLINE goalscorer feed (PlayerId), evidence snapshot recorded — NOT chain-proven',
  };
}

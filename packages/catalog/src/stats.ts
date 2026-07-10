/**
 * On-chain provable soccer stat catalog (spec §3, confirmed by TxLINE docs).
 * Base keys are full-game; period-scoped keys add (period * 1000).
 */

export const STAT = {
  P1_GOALS: 1,
  P2_GOALS: 2,
  P1_YELLOW: 3,
  P2_YELLOW: 4,
  P1_RED: 5,
  P2_RED: 6,
  P1_CORNERS: 7,
  P2_CORNERS: 8,
} as const;

/** Stat-period offsets (NOT game-phase status ids). 0 = full game. */
export const STAT_PERIOD = {
  FULL: 0,
  H1: 1,
  H2: 2,
  ET1: 3,
  ET2: 4,
  PE: 5,
} as const;
export type StatPeriod = (typeof STAT_PERIOD)[keyof typeof STAT_PERIOD];

/** Period-scoped stat key: (period * 1000) + base. */
export const statKey = (base: number, period: StatPeriod = 0): number => period * 1000 + base;

export const STAT_LABEL: Record<number, string> = {
  1: 'goals (home)',
  2: 'goals (away)',
  3: 'yellow cards (home)',
  4: 'yellow cards (away)',
  5: 'red cards (home)',
  6: 'red cards (away)',
  7: 'corners (home)',
  8: 'corners (away)',
};

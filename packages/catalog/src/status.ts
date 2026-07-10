/** Soccer game-phase status ids (TxLINE soccer feed encoding, verified). */
export const SOCCER_STATUS = {
  NS: 1,
  H1: 2,
  HT: 3,
  H2: 4,
  F: 5,
  WET: 6,
  ET1: 7,
  HTET: 8,
  ET2: 9,
  FET: 10,
  WPE: 11,
  PE: 12,
  FPE: 13,
  I: 14, // interrupted
  A: 15, // abandoned
  C: 16, // cancelled
  TXCC: 17, // coverage cancelled
  TXCS: 18, // coverage suspended
  P: 19, // postponed
} as const;

export type SoccerStatusId = (typeof SOCCER_STATUS)[keyof typeof SOCCER_STATUS];

/** Regulation/ET/pens fully finished — final stats are known. */
export const FINISHED_STATUSES: ReadonlySet<number> = new Set([
  SOCCER_STATUS.F,
  SOCCER_STATUS.FET,
  SOCCER_STATUS.FPE,
]);

/** Statuses that void markets (spec §12.5). */
export const VOID_STATUSES: ReadonlySet<number> = new Set([
  SOCCER_STATUS.A,
  SOCCER_STATUS.C,
  SOCCER_STATUS.TXCC,
  SOCCER_STATUS.TXCS,
  SOCCER_STATUS.P,
]);

/** In-play (clock running or break inside the match). */
export const IN_PLAY_STATUSES: ReadonlySet<number> = new Set([
  SOCCER_STATUS.H1,
  SOCCER_STATUS.HT,
  SOCCER_STATUS.H2,
  SOCCER_STATUS.WET,
  SOCCER_STATUS.ET1,
  SOCCER_STATUS.HTET,
  SOCCER_STATUS.ET2,
  SOCCER_STATUS.WPE,
  SOCCER_STATUS.PE,
]);

export const STATUS_LABEL: Record<number, string> = {
  1: 'Not started',
  2: '1st half',
  3: 'Half-time',
  4: '2nd half',
  5: 'Full time',
  6: 'Waiting for extra time',
  7: 'ET 1st half',
  8: 'ET half-time',
  9: 'ET 2nd half',
  10: 'Finished after ET',
  11: 'Waiting for penalties',
  12: 'Penalty shootout',
  13: 'Finished after penalties',
  14: 'Interrupted',
  15: 'Abandoned',
  16: 'Cancelled',
  17: 'Coverage cancelled',
  18: 'Coverage suspended',
  19: 'Postponed',
};

/**
 * First status at which a market scoped to the given stat period has final,
 * settled values (used by the settler to detect deciding events).
 */
export function decidingStatusFor(period: number): ReadonlySet<number> {
  switch (period) {
    case 1: // H1 stats final from half-time onward
      return new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    case 2: // H2 stats final at full time (and beyond)
      return new Set([5, 6, 7, 8, 9, 10, 11, 12, 13]);
    case 3: // ET1 finals from ET half-time
      return new Set([8, 9, 10, 11, 12, 13]);
    case 4: // ET2 finals when ET ends
      return new Set([10, 11, 12, 13]);
    case 5: // penalty-shootout stats final when the match ends after pens
      return new Set([13]);
    default: // full-game stats final only when the match is fully over
      return FINISHED_STATUSES;
  }
}

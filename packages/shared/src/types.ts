/** Verifiability class of a market (spec §3/§6). Shown as a badge on every card. */
export type MarketClass = 'A' | 'B' | 'C';

/** Market lifecycle states (spec §8). */
export type MarketState =
  | 'Draft'
  | 'Open'
  | 'Locked'
  | 'InPlay'
  | 'AwaitingRoot'
  | 'Resolving'
  | 'Settled'
  | 'Void';

export type MarketSide = 'YES' | 'NO';

/** Days since Unix epoch (UTC) — the unit used by TxLINE roots and fixture queries. */
export function epochDay(tsMs: number = Date.now()): number {
  return Math.floor(tsMs / 86_400_000);
}

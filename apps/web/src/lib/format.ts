import type { FixtureRow, MarketRow } from './api.js';

export const usdt = (micro: number) =>
  (micro / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Decimal odds from real pool balances (parimutuel): total / side. */
export function decimalOdds(m: MarketRow): { yes: string; no: string } {
  const total = m.yesPool + m.noPool;
  const fmt = (side: number) => (side > 0 && total > side ? (total / side).toFixed(2) : '—');
  if (total === 0) return { yes: '—', no: '—' };
  return { yes: fmt(m.yesPool), no: fmt(m.noPool) };
}

export const STATUS_LABEL: Record<number, string> = {
  1: 'Not started', 2: '1st half', 3: 'HT', 4: '2nd half', 5: 'FT',
  6: 'Waiting ET', 7: 'ET1', 8: 'ET HT', 9: 'ET2', 10: 'AET',
  11: 'Waiting pens', 12: 'Pens', 13: 'After pens', 14: 'Interrupted',
  15: 'Abandoned', 16: 'Cancelled', 17: 'Coverage cancelled',
  18: 'Coverage suspended', 19: 'Postponed',
};

const IN_PLAY = new Set([2, 3, 4, 6, 7, 8, 9, 11, 12]);

export const isLive = (f: FixtureRow) => f.statusId !== null && IN_PLAY.has(f.statusId);

/** Match minute chip from the real feed clock; falls back to phase label. */
export function minuteChip(f: FixtureRow): string | null {
  if (!isLive(f)) return null;
  if (f.statusId === 3) return 'HT';
  if (f.clockSeconds != null && f.clockSeconds > 0) {
    return `${Math.min(130, Math.floor(f.clockSeconds / 60) + 1)}'`;
  }
  return STATUS_LABEL[f.statusId!] ?? null;
}

export function scoreOf(f: FixtureRow): string {
  if (!f.scoreJson) return '0 - 0';
  try {
    const s = JSON.parse(f.scoreJson) as {
      Participant1?: { Total?: { Goals?: number } };
      Participant2?: { Total?: { Goals?: number } };
    };
    const p1 = s.Participant1?.Total?.Goals ?? 0;
    const p2 = s.Participant2?.Total?.Goals ?? 0;
    return f.homeIsP1 ? `${p1} - ${p2}` : `${p2} - ${p1}`;
  } catch {
    return '0 - 0';
  }
}

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

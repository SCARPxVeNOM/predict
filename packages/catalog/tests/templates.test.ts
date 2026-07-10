import { describe, expect, it } from 'vitest';
import { classAMarkets, decidingStatusFor, isLocked, SOCCER_STATUS, statKey } from '../src/index.js';

const fx = { fixtureId: 18209181, home: 'France', away: 'Morocco' };

describe('classAMarkets', () => {
  const defs = classAMarkets(fx);

  it('creates the full-game catalog with unique slugs', () => {
    const slugs = defs.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('ou-goals-2.5');
    expect(slugs).toContain('home-win');
    expect(slugs).toContain('btts');
  });

  it('every card is Class A with a class badge and resolution method', () => {
    for (const d of defs) {
      expect(d.marketClass).toBe('A');
      expect(d.resolutionMethod).toMatch(/Merkle proof/);
    }
  });

  it('encodes O/U 2.5 as (P1+P2 goals) GreaterThan 2', () => {
    const ou = defs.find((d) => d.slug === 'ou-goals-2.5')!;
    expect(ou.terms).toMatchObject({
      statAKey: 1,
      statBKey: 2,
      op: 'Add',
      predicate: { threshold: 2, comparison: 'GreaterThan' },
      negation: false,
    });
  });

  it('encodes home win as (P1-P2) GreaterThan 0 and draw as EqualTo 0', () => {
    expect(defs.find((d) => d.slug === 'home-win')!.terms).toMatchObject({
      op: 'Subtract',
      predicate: { threshold: 0, comparison: 'GreaterThan' },
    });
    expect(defs.find((d) => d.slug === 'draw')!.terms).toMatchObject({
      op: 'Subtract',
      predicate: { threshold: 0, comparison: 'EqualTo' },
    });
  });

  it('BTTS is a composite of two single-stat proofs (spec §3)', () => {
    const btts = defs.find((d) => d.slug === 'btts')!;
    expect(btts.terms.statAKey).toBe(1);
    expect(btts.andTerms).toHaveLength(1);
    expect(btts.andTerms![0]).toMatchObject({ statAKey: 2, predicate: { threshold: 0 } });
  });

  it('period-scoped keys follow (period*1000)+base', () => {
    expect(statKey(1, 1)).toBe(1001);
    expect(statKey(8, 5)).toBe(5008);
    const h1 = classAMarkets(fx, 1);
    expect(h1.find((d) => d.slug === 'ou-goals-0.5-p1')!.terms.statAKey).toBe(1001);
  });
});

describe('lock rules (60s-delay honesty, spec §5.1)', () => {
  const start = Date.now() + 10 * 60_000;
  it('locks 2 minutes before kickoff', () => {
    expect(isLocked('kickoff', { now: start - 3 * 60_000, startTime: start, statusId: 1 })).toBe(false);
    expect(isLocked('kickoff', { now: start - 60_000, startTime: start, statusId: 1 })).toBe(true);
  });
  it('locks the moment the feed leaves Not-Started even if clock says early', () => {
    expect(
      isLocked('kickoff', { now: start - 10 * 60_000, startTime: start, statusId: SOCCER_STATUS.H1 }),
    ).toBe(true);
  });
});

describe('deciding statuses per stat period', () => {
  it('full-game stats decide only at F/FET/FPE', () => {
    const s = decidingStatusFor(0);
    expect(s.has(SOCCER_STATUS.F)).toBe(true);
    expect(s.has(SOCCER_STATUS.HT)).toBe(false);
  });
  it('H1 stats decide from half-time onward', () => {
    expect(decidingStatusFor(1).has(SOCCER_STATUS.HT)).toBe(true);
  });
});

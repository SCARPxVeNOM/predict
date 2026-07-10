import { describe, expect, it } from 'vitest';
import { encodeMarketIntentParams, fromPlainTerms, termsHashHex } from '../src/terms.js';

const plain = {
  fixtureId: 18202783,
  period: 0,
  statAKey: 1,
  statBKey: 2 as number | null,
  predicate: { threshold: 2, comparison: 'GreaterThan' as const },
  op: 'Add' as const,
  negation: false,
};

describe('terms encoding + hash', () => {
  it('borsh layout is stable (regression vector)', () => {
    const bytes = encodeMarketIntentParams(fromPlainTerms(plain));
    // i64 fixture LE + u16 period + u32 statA + Option<u32> statB +
    // predicate {i32 threshold, enum u8} + Option<enum u8> + bool
    expect(bytes.length).toBe(8 + 2 + 4 + 5 + 5 + 2 + 1);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x9f, 0xc0, 0x15, 0x01, 0, 0, 0, 0]), // 18202783 LE
    );
  });

  it('hash matches the devnet-observed vector for these exact terms', () => {
    // Same terms were used in the on-chain round-trip on 2026-07-09.
    expect(termsHashHex(fromPlainTerms(plain))).toBe(
      '0bd524d8191fa378ca115708d8190b3ed73211d2e2f1027ea9752ac740118437',
    );
  });

  it('negation and thresholds change the hash', () => {
    const a = termsHashHex(fromPlainTerms(plain));
    const b = termsHashHex(fromPlainTerms({ ...plain, negation: true }));
    const c = termsHashHex(
      fromPlainTerms({ ...plain, predicate: { threshold: 3, comparison: 'GreaterThan' } }),
    );
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('single-stat terms omit statB and op', () => {
    const single = fromPlainTerms({ ...plain, statBKey: null, op: null });
    const bytes = encodeMarketIntentParams(single);
    expect(bytes.length).toBe(8 + 2 + 4 + 1 + 5 + 1 + 1);
  });
});

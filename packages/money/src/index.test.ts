import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ZERO,
  add,
  allocate,
  allocateByWeight,
  divRate,
  fromCents,
  fromDisplay,
  mulRate,
  ratio,
  sub,
  sum,
  toCompact,
  toDisplay,
  usd,
} from './index.js';

describe('fromDisplay / fromCents', () => {
  it('converts dollars to integer cents', () => {
    expect(fromDisplay(100_000)).toBe(10_000_000n);
    expect(fromDisplay(4.5)).toBe(450n);
    expect(fromDisplay(0.01)).toBe(1n);
    expect(fromDisplay(-12.34)).toBe(-1234n);
  });

  it('parses strings exactly, without a float round-trip', () => {
    expect(fromDisplay('1234.56')).toBe(123_456n);
    expect(fromDisplay('$1,234.56')).toBe(123_456n);
    expect(fromDisplay('-0.05')).toBe(-5n);
    expect(fromDisplay('0.005')).toBe(1n); // half away from zero
    expect(fromDisplay('0.004')).toBe(0n);
  });

  it('rejects nonsense', () => {
    expect(() => fromDisplay('abc')).toThrow();
    expect(() => fromDisplay(Number.NaN)).toThrow();
    expect(() => fromDisplay(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => fromCents(1.5)).toThrow();
  });
});

describe('mulRate rounding contract', () => {
  it('rounds half away from zero, not half to even', () => {
    // 5 cents × 0.5 = 2.5 → 3, and -3 on the negative side.
    expect(mulRate(5n, 0.5)).toBe(3n);
    expect(mulRate(-5n, 0.5)).toBe(-3n);
    expect(mulRate(15n, 0.5)).toBe(8n); // 7.5 → 8, NOT 8-to-even coincidence
    expect(mulRate(25n, 0.5)).toBe(13n); // 12.5 → 13; half-to-even would give 12
  });

  it('is exact on identity and zero', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }), (m) => {
        expect(mulRate(m, 1)).toBe(m);
        expect(mulRate(m, 0)).toBe(ZERO);
      }),
    );
  });

  it('is sign-symmetric', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (m, r) => {
          expect(mulRate(-m, r)).toBe(-mulRate(m, r));
        },
      ),
    );
  });

  it('never drifts more than half a cent from the exact product', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.double({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        (m, r) => {
          const exact = Number(m) * r;
          const got = Number(mulRate(m, r));
          // Allow for double imprecision in the reference computation itself.
          expect(Math.abs(got - exact)).toBeLessThanOrEqual(0.5 + Math.abs(exact) * 1e-12);
        },
      ),
    );
  });

  it('does not accumulate drift over long chains', () => {
    // A rate applied 10,000 times must not wander from a single application of
    // the compounded rate by more than the per-step rounding allowance.
    let running = fromDisplay(1_000_000);
    for (let i = 0; i < 10_000; i++) running = mulRate(running, 1.0001);
    const expected = 1_000_000 * 1.0001 ** 10_000;
    expect(Math.abs(Number(running) / 100 - expected)).toBeLessThan(expected * 1e-6);
  });

  it('handles very large quantities without precision loss', () => {
    // The naive `Math.round(rate * 1e9)` implementation fails this: the scaled
    // rate exceeds MAX_SAFE_INTEGER and silently loses low-order digits.
    expect(mulRate(100n, 1e9)).toBe(100_000_000_000n);
    expect(mulRate(1n, 12_345_678.9)).toBe(12_345_679n);
  });
});

describe('divRate', () => {
  it('inverts a lossless scaling exactly', () => {
    // Only lossless directions round-trip. Scaling UP by an integer is exact,
    // so dividing back recovers the input. Scaling DOWN rounds, and no inverse
    // can recover what rounding discarded — asserting otherwise would be
    // asserting that mulRate does not round.
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 1000 }),
        (m, k) => {
          expect(divRate(mulRate(m, k), k)).toBe(m);
        },
      ),
    );
  });

  it('lands within half a cent of exact division', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.double({ min: 0.001, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        (m, d) => {
          const exact = Number(m) / d;
          expect(Math.abs(Number(divRate(m, d)) - exact)).toBeLessThanOrEqual(
            0.5 + Math.abs(exact) * 1e-12,
          );
        },
      ),
    );
  });

  it('rejects division by zero', () => {
    expect(() => divRate(100n, 0)).toThrow();
  });
});

describe('allocate', () => {
  it('splits without losing or inventing cents', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 50 }),
        (amount, parts) => {
          const pieces = allocate(amount, parts);
          expect(pieces).toHaveLength(parts);
          expect(sum(pieces)).toBe(amount);
        },
      ),
    );
  });

  it('spreads the remainder rather than dumping it on one piece', () => {
    expect(allocate(10n, 3)).toEqual([4n, 3n, 3n]);
    expect(allocate(-10n, 3)).toEqual([-4n, -3n, -3n]);
  });
});

describe('allocateByWeight', () => {
  it('sums exactly to the input regardless of weights', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.array(fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 12,
        }),
        (amount, weights) => {
          expect(sum(allocateByWeight(amount, weights))).toBe(amount);
        },
      ),
    );
  });

  it('falls back to an even split when all weights are zero', () => {
    expect(allocateByWeight(9n, [0, 0, 0])).toEqual([3n, 3n, 3n]);
  });

  it('allocates proportionally', () => {
    expect(allocateByWeight(fromDisplay(100), [3, 1])).toEqual([
      fromDisplay(75),
      fromDisplay(25),
    ]);
  });
});

describe('add / sub / sum', () => {
  it('are exact', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }), { maxLength: 100 }),
        (values) => {
          let expected = 0n;
          for (const v of values) expected += v;
          expect(sum(values)).toBe(expected);
        },
      ),
    );
    expect(add(1n, 2n)).toBe(3n);
    expect(sub(1n, 2n)).toBe(-1n);
  });
});

describe('ratio', () => {
  it('returns zero for a zero denominator rather than NaN or Infinity', () => {
    expect(ratio(100n, 0n)).toBe(0);
  });

  it('computes margins', () => {
    expect(ratio(fromDisplay(30), fromDisplay(100))).toBeCloseTo(0.3, 10);
  });
});

describe('display', () => {
  it('formats with grouping and a fixed two decimals', () => {
    expect(toDisplay(usd(1234.5))).toBe('$1,234.50');
    expect(toDisplay(usd(-1234.56))).toBe('-$1,234.56');
    expect(toDisplay(usd(0))).toBe('$0.00');
    expect(toDisplay(usd(1234.56), { showCents: false })).toBe('$1,234');
  });

  it('compacts large magnitudes', () => {
    expect(toCompact(usd(1_500_000))).toBe('$1.5M');
    expect(toCompact(usd(-2_400))).toBe('-$2.4k');
    expect(toCompact(usd(12))).toBe('$12');
  });

  it('round-trips through the display parser', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }), (m) => {
        expect(fromDisplay(toDisplay(m).replace('-$', '-').replace('$', ''))).toBe(m);
      }),
    );
  });
});

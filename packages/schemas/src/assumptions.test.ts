import { describe, expect, it } from 'vitest';
import {
  benchmarkDeviation,
  deviationLabel,
  isOutsideBenchmark,
  type Assumption,
} from './assumptions.js';

/**
 * D-5: benchmarks are weak constraints, so the register has to report *how far*
 * outside, not merely *that* a value is outside. A flag says the same word for
 * 1.1x and 22x, which leaves the challenge loop nothing to argue with.
 */

function assumption(over: Partial<Assumption> = {}): Assumption {
  return {
    id: 'a1',
    businessId: 'b1',
    path: 'streams[0].params.avgTicket',
    label: 'Average ticket',
    category: 'REVENUE',
    value: 9,
    unit: 'USD',
    isMoney: false,
    range: { low: 6, high: 12 },
    provenance: 'BENCHMARK',
    sourceNote: 'test',
    outsideBenchmark: false,
    challengeHistory: [],
    ...over,
  };
}

describe('benchmarkDeviation', () => {
  it('is absent when there is no band — an unbenchmarked value is not a finding', () => {
    expect(benchmarkDeviation(assumption())).toBeUndefined();
    expect(deviationLabel(assumption())).toBeUndefined();
  });

  it('is zero inside the band, including exactly on either edge', () => {
    const band = { low: 8, high: 12, source: 'test' };
    expect(benchmarkDeviation(assumption({ value: 10, benchmarkBand: band }))).toBe(0);
    expect(benchmarkDeviation(assumption({ value: 8, benchmarkBand: band }))).toBe(0);
    expect(benchmarkDeviation(assumption({ value: 12, benchmarkBand: band }))).toBe(0);
    // In band is not a finding, so there is nothing to say about it.
    expect(deviationLabel(assumption({ value: 10, benchmarkBand: band }))).toBeUndefined();
  });

  it('signs the deviation by direction', () => {
    const band = { low: 8, high: 12, source: 'test' };
    expect(benchmarkDeviation(assumption({ value: 16, benchmarkBand: band }))).toBe(1);
    expect(benchmarkDeviation(assumption({ value: 4, benchmarkBand: band }))).toBe(-1);
  });

  it('separates the merely-high from the startling, which is the whole point', () => {
    const band = { low: 8, high: 12, source: 'test' };
    const nudged = benchmarkDeviation(assumption({ value: 13, benchmarkBand: band }))!;
    const absurd = benchmarkDeviation(assumption({ value: 200, benchmarkBand: band }))!;

    expect(nudged).toBeCloseTo(0.25, 6);
    expect(absurd).toBeCloseTo(47, 6);
    // The flag cannot tell these apart. That is the defect D-5 names.
    expect(isOutsideBenchmark(assumption({ value: 13, benchmarkBand: band }))).toBe(true);
    expect(isOutsideBenchmark(assumption({ value: 200, benchmarkBand: band }))).toBe(true);
  });

  it('reads money in dollars, not the cents the engine stores', () => {
    const a = assumption({
      value: 20_000_00n,
      isMoney: true,
      benchmarkBand: { low: 15_000, high: 60_000, source: 'test' },
    });
    expect(benchmarkDeviation(a)).toBe(0); // $20,000 is in a $15k–$60k band
  });

  it('survives a band that straddles zero, where a ratio to the edge would not', () => {
    // A seed-stage SaaS EBITDA band genuinely runs deeply negative (see the
    // b2b_saas template). `value / low` here is nonsense; band-widths are not.
    const band = { low: -0.15, high: 0.3, source: 'seed SaaS' };
    expect(benchmarkDeviation(assumption({ value: -0.6, benchmarkBand: band }))).toBeCloseTo(-1, 6);
    expect(benchmarkDeviation(assumption({ value: 0.75, benchmarkBand: band }))).toBeCloseTo(1, 6);
  });

  it('does not divide by a zero-width band', () => {
    const band = { low: 5, high: 5, source: 'test' };
    expect(benchmarkDeviation(assumption({ value: 9, benchmarkBand: band }))).toBe(1);
    expect(benchmarkDeviation(assumption({ value: 1, benchmarkBand: band }))).toBe(-1);
    expect(benchmarkDeviation(assumption({ value: 5, benchmarkBand: band }))).toBe(0);
  });
});

describe('deviationLabel', () => {
  it('speaks in multiples when the band is positive — how a person judges a number', () => {
    const band = { low: 8, high: 12, source: 'test' };
    expect(deviationLabel(assumption({ value: 200, benchmarkBand: band }))).toBe(
      '17× the top of the range',
    );
    expect(deviationLabel(assumption({ value: 18, benchmarkBand: band }))).toBe(
      '1.5× the top of the range',
    );
    expect(deviationLabel(assumption({ value: 2, benchmarkBand: band }))).toBe(
      '0.3× the bottom of the range',
    );
  });

  it('falls back to band-widths when a multiple would mislead', () => {
    const band = { low: -0.15, high: 0.3, source: 'seed SaaS' };
    expect(deviationLabel(assumption({ value: -0.6, benchmarkBand: band }))).toBe(
      '1.0 band-widths below the bottom of the range',
    );
  });

  it('renders the $200 scoop as the question it should provoke', () => {
    // D-5's worked example: a 256-flavour shop may charge more than Ben &
    // Jerry's. It cannot charge $200 a scoop — and the register should say so
    // as a magnitude the player can answer for, not as a verdict.
    const a = assumption({
      label: 'Average ticket',
      value: 200_00n,
      isMoney: true,
      benchmarkBand: { low: 6, high: 13, source: 'scoop shop ticket' },
    });
    expect(a.benchmarkBand).toBeDefined();
    expect(deviationLabel(a)).toBe('15× the top of the range');
  });
});

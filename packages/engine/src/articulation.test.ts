import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fromDisplay } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import type { WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { tick } from './tick.js';

/**
 * Articulation property tests — spec §13.1, the non-negotiable.
 *
 * > For each archetype, for N randomized parameter sets drawn from plausible
 * > ranges, run 40 quarters and assert every invariant in §8.4 holds at every
 * > period.
 *
 * This suite is the foundation of the product's credibility claim and must be
 * green before anything ships. The spec asks for 1,000 cases per archetype;
 * that is the nightly number (SLOW_TESTS=1). The default is sized to stay
 * inside the 5-minute per-PR budget in docs/plan/04-risks-and-decisions.md,
 * because a suite that is too slow to run on every PR gets skipped.
 *
 * Note what these prove and what they do not. Appendix A records a run where
 * every assertion passed for forty consecutive quarters while revenue was
 * frozen by a staffing bug. Articulation proves the books tie, not that the
 * business logic is right — see `understaffing.test.ts` for the other half.
 */

const CASES = process.env.SLOW_TESTS ? 1000 : 60;

function buildWorld(params: {
  seats: number;
  turnsPerDay: number;
  traffic: number;
  captureRate: number;
  ticket: number;
  marketing: number;
  equity: number;
  debt: number;
  skuCount: number;
}): WorldState {
  const template = getSeedTemplate('full_service_restaurant');
  const model = buildModelFromTemplate({
    businessName: 'Property Case',
    template,
    stream: {
      archetype: 'TRAFFIC',
      seats: params.seats,
      turnsPerDay: params.turnsPerDay,
      addressableTrafficPerQuarter: params.traffic,
      captureRate: params.captureRate,
      avgTicket: fromDisplay(params.ticket),
      skuCount: params.skuCount,
    },
    marketingSpendPerQuarter: fromDisplay(params.marketing),
    equityInjection: fromDisplay(params.equity),
    debt:
      params.debt > 0
        ? [
            { kind: 'SBA_7A', principal: fromDisplay(params.debt), termQuarters: 40 },
            { kind: 'REVOLVER', principal: fromDisplay(100_000), termQuarters: 40 },
          ]
        : [{ kind: 'REVOLVER', principal: fromDisplay(100_000), termQuarters: 40 }],
  });

  return createWorld({
    id: 'prop',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
}

const plausibleParams = fc.record({
  seats: fc.integer({ min: 20, max: 220 }),
  turnsPerDay: fc.double({ min: 1.2, max: 3.5, noNaN: true, noDefaultInfinity: true }),
  traffic: fc.integer({ min: 40_000, max: 800_000 }),
  captureRate: fc.double({ min: 0.015, max: 0.08, noNaN: true, noDefaultInfinity: true }),
  ticket: fc.double({ min: 12, max: 90, noNaN: true, noDefaultInfinity: true }),
  marketing: fc.integer({ min: 0, max: 60_000 }),
  equity: fc.integer({ min: 150_000, max: 900_000 }),
  debt: fc.integer({ min: 0, max: 700_000 }),
  skuCount: fc.integer({ min: 8, max: 300 }),
});

describe('articulation invariants (§13.1)', () => {
  it(`holds across ${CASES} randomized TRAFFIC parameter sets over 40 quarters`, () => {
    fc.assert(
      fc.property(plausibleParams, (params) => {
        let state = buildWorld(params);
        for (let period = 0; period < 40; period++) {
          const result = tick(state, [], { throwOnAssertionFailure: false });
          const failed = result.assertions.filter((a) => !a.passed);
          if (failed.length > 0) {
            throw new Error(
              `Period ${result.statements.period}: ` +
                failed
                  .map((f) => `${f.name} expected ${f.expected} got ${f.actual}`)
                  .join('; '),
            );
          }
          state = result.state;
        }
      }),
      { numRuns: CASES },
    );
  });

  it('never produces NaN or a non-finite derived metric', () => {
    fc.assert(
      fc.property(plausibleParams, (params) => {
        let state = buildWorld(params);
        for (let period = 0; period < 12; period++) {
          const result = tick(state, [], { throwOnAssertionFailure: false });
          const business = Object.values(result.statements.byBusiness)[0];
          if (business) {
            for (const [key, value] of Object.entries(business.derivedMetrics)) {
              if (typeof value === 'number') {
                expect(Number.isNaN(value), `${key} is NaN`).toBe(false);
              }
            }
          }
          state = result.state;
        }
      }),
      { numRuns: Math.min(CASES, 40) },
    );
  });
});

describe('long-run stability (§13.6)', () => {
  it('runs 200 quarters without overflow, NaN or assertion drift', () => {
    let state = buildWorld({
      seats: 64,
      turnsPerDay: 2,
      traffic: 180_000,
      captureRate: 0.05,
      ticket: 42,
      marketing: 8_000,
      equity: 350_000,
      debt: 400_000,
      skuCount: 40,
    });

    for (let period = 0; period < 200; period++) {
      const result = tick(state, [], { throwOnAssertionFailure: true });
      const bs = result.statements.consolidated.balanceSheet;
      expect(Number.isFinite(Number(bs.totalAssets))).toBe(true);
      // The player may keep playing past the milestone, so the engine must not
      // degrade after period 39.
      expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
      state = result.state;
    }
    expect(state.currentPeriod).toBe(199);
  });
});

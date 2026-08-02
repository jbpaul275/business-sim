import { describe, expect, it } from 'vitest';
import { fromDisplay, type Money } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import type { CrisisRemedy, WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { tick } from './tick.js';

/**
 * Cash crisis resolution — spec §9.4.
 *
 * The crisis path is where stale income statements hide: every remedy changes
 * something computed before step 17, so each of these tests runs the full
 * assertion set afterwards. If resolution re-entered at step 17 instead of
 * step 8, these would fail — which is the good outcome. The bad outcome is
 * silently disabling the assertion.
 */

/**
 * A business capitalised well enough to OPEN — month-zero outlays run about
 * $640k for this template — but with unit economics too weak to sustain it.
 * Under-capitalising it instead would only test that a business which cannot
 * pay for its own buildout is insolvent on day one, which proves nothing about
 * the ladder.
 */
function strugglingWorld(policy: CrisisRemedy[], equity = 700_000): WorldState {
  const model = buildModelFromTemplate({
    businessName: 'Struggling',
    template: getSeedTemplate('full_service_restaurant'),
    scale: {
      seats: 90,
      turnsPerDay: 2,
      addressableTrafficPerQuarter: 95_000,
      captureRate: 0.035,
      price: fromDisplay(28),
    },
    marketingSpendPerQuarter: fromDisplay(12_000),
    equityInjection: fromDisplay(equity),
    debt: [{ kind: 'REVOLVER', principal: fromDisplay(80_000), termQuarters: 40 }],
  });

  const world = createWorld({
    id: 'crisis',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
  world.config.crisisPolicy = policy;
  return world;
}

function runUntilCrisis(state: WorldState, periods: number) {
  const applied: string[] = [];
  let current = state;
  let sawCrisis = false;
  for (let i = 0; i < periods; i++) {
    // Assertions throw here — the whole point is that they hold THROUGH the
    // crisis path, not just around it.
    const result = tick(current, [], { throwOnAssertionFailure: true });
    for (const event of result.events) {
      if (event.kind === 'CASH_CRISIS') sawCrisis = true;
      if (event.kind === 'CRISIS_REMEDY_APPLIED') applied.push(String(event.detail.remedy));
    }
    current = result.state;
  }
  return { applied, sawCrisis, final: current };
}

describe('crisis ladder (§9.4)', () => {
  it('never lets a business end a period with negative cash', () => {
    const { final } = runUntilCrisis(strugglingWorld(['REVOLVER', 'HOUSEHOLD_INJECTION', 'EMERGENCY_DEBT', 'INSOLVENCY']), 24);
    for (const business of final.businesses) {
      expect(business.cash).toBeGreaterThanOrEqual(0n);
    }
  });

  it('applies remedies in the pre-declared order, not an order of its own', () => {
    const { applied, sawCrisis } = runUntilCrisis(
      strugglingWorld(['DEFER_OWNER_COMP', 'REVOLVER', 'EMERGENCY_DEBT', 'INSOLVENCY']),
      12,
    );
    expect(sawCrisis).toBe(true);
    // The player put owner-comp deferral first, so it must be reached first.
    expect(applied[0]).toBe('DEFER_OWNER_COMP');
  });

  it('a different policy produces a different resolution from the same start', () => {
    const revolverFirst = runUntilCrisis(
      strugglingWorld(['REVOLVER', 'EMERGENCY_DEBT', 'INSOLVENCY']),
      12,
    );
    const deferFirst = runUntilCrisis(
      strugglingWorld(['DEFER_OWNER_COMP', 'EMERGENCY_DEBT', 'INSOLVENCY']),
      12,
    );
    expect(revolverFirst.applied[0]).not.toBe(deferFirst.applied[0]);
  });

  it('holds every articulation assertion through the whole ladder', () => {
    // Force the expensive end of the ladder by removing the cheap options.
    const world = strugglingWorld(
      ['FACTOR_AR', 'DEFER_OWNER_COMP', 'SALE_LEASEBACK', 'EMERGENCY_DEBT', 'INSOLVENCY'],
      680_000,
    );
    let current = world;
    let remedies = 0;
    for (let i = 0; i < 20; i++) {
      const result = tick(current, [], { throwOnAssertionFailure: true });
      remedies += result.events.filter((e) => e.kind === 'CRISIS_REMEDY_APPLIED').length;
      expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
      current = result.state;
    }
    expect(remedies).toBeGreaterThan(0);
  });

  it('deferred owner compensation accrues as a liability rather than vanishing', () => {
    const world = strugglingWorld(['DEFER_OWNER_COMP', 'EMERGENCY_DEBT', 'INSOLVENCY']);
    let current = world;
    let sawLiability = false;
    for (let i = 0; i < 12; i++) {
      const result = tick(current, [], { throwOnAssertionFailure: true });
      const bs = result.statements.consolidated.balanceSheet;
      if (bs.deferredOwnerComp > 0n) sawLiability = true;
      current = result.state;
    }
    expect(sawLiability, 'owner comp was deferred but no liability appeared').toBe(true);
  });
});

describe('insolvency (§9.4)', () => {
  it('closes the business, ties the books, and attaches guaranteed debt to the household', () => {
    const model = buildModelFromTemplate({
      businessName: 'Doomed',
      template: getSeedTemplate('full_service_restaurant'),
      scale: {
        seats: 120,
        turnsPerDay: 2,
        addressableTrafficPerQuarter: 30_000,
        captureRate: 0.02,
        price: fromDisplay(20),
      },
      equityInjection: fromDisplay(400_000),
      debt: [{ kind: 'SBA_7A', principal: fromDisplay(300_000), termQuarters: 40 }],
    });
    const world = createWorld({
      id: 'doomed',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [model],
    });
    world.config.crisisPolicy = ['INSOLVENCY'];

    let current = world;
    let closed = false;
    for (let i = 0; i < 12 && !closed; i++) {
      const result = tick(current, [], { throwOnAssertionFailure: true });
      // The terminal statement must tie like any other.
      const bs = result.statements.consolidated.balanceSheet;
      expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
      current = result.state;
      closed = current.businesses.every((b) => b.status === 'CLOSED');
    }

    expect(closed, 'the business never reached insolvency').toBe(true);
    // A personally guaranteed deficiency follows the founder home, and credit
    // is impaired for eight quarters. This is the real trap of small-business
    // lending and it should not be softened.
    expect(current.household.creditQuality).toBe('IMPAIRED');
    expect(current.household.personalDebts.length).toBeGreaterThan(0);
  });

  it('leaves other businesses untouched unless cross-guaranteed', () => {
    const template = getSeedTemplate('full_service_restaurant');
    const healthy = buildModelFromTemplate({
      businessName: 'Healthy',
      template,
      scale: {
        seats: 64,
        turnsPerDay: 2,
        addressableTrafficPerQuarter: 180_000,
        captureRate: 0.05,
        price: fromDisplay(42),
      },
      equityInjection: fromDisplay(800_000),
    });
    const doomed = buildModelFromTemplate({
      businessName: 'Doomed',
      template,
      scale: {
        seats: 120,
        turnsPerDay: 2,
        addressableTrafficPerQuarter: 20_000,
        captureRate: 0.02,
        price: fromDisplay(18),
      },
      equityInjection: fromDisplay(650_000),
    });

    const world = createWorld({
      id: 'multi',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'FREEPLAY', customCapital: fromDisplay(2_000_000) }),
      models: [healthy, doomed],
    });
    world.config.crisisPolicy = ['INSOLVENCY'];

    let current = world;
    for (let i = 0; i < 16; i++) {
      current = tick(current, [], { throwOnAssertionFailure: true }).state;
    }

    const statuses = current.businesses.map((b) => b.status);
    expect(statuses).toContain('CLOSED');
    expect(statuses.some((s) => s === 'OPERATING' || s === 'PRE_LAUNCH')).toBe(true);
  });
});

describe('peak cash need (§5.4)', () => {
  it('is reported as a running extremum, not a per-period figure', () => {
    const model = buildModelFromTemplate({
      businessName: 'Peak',
      template: getSeedTemplate('full_service_restaurant'),
      scale: {
        seats: 64,
        turnsPerDay: 2,
        addressableTrafficPerQuarter: 180_000,
        captureRate: 0.05,
        price: fromDisplay(42),
      },
      equityInjection: fromDisplay(500_000),
    });
    const world = createWorld({
      id: 'peak',
      playerId: 'p',
      config: createWorldConfig({ startMode: 'MID' }),
      models: [model],
    });

    // Month-zero outlays alone already establish a floor before any quarter runs.
    const opening: Money = world.businesses[0]!.peakCashNeed;
    expect(opening).toBeGreaterThan(0n);

    let current = world;
    let previous = opening;
    for (let i = 0; i < 20; i++) {
      current = tick(current, [], { throwOnAssertionFailure: true }).state;
      const need = current.businesses[0]!.peakCashNeed;
      // Monotone non-decreasing: it is a maximum over periods.
      expect(need).toBeGreaterThanOrEqual(previous);
      previous = need;
    }
  });
});

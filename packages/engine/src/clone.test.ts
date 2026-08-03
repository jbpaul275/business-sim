import { describe, expect, it } from 'vitest';
import { fromDisplay, sum, type Money } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import type { Action, WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { CLONE_RAMP_CEILING, cloneOutlay, saleValue } from './clone.js';
import { createWorld, createWorldConfig } from './opening.js';
import { tick } from './tick.js';

/**
 * A second one — spec §9.5.
 *
 * "I want to use the cash flow from this one to buy a 256 room property in Des
 * Moines" was answered, for most of this project's life, with "you are at 57.6%
 * of capacity". These are the tests for the answer.
 */

function world(equity = 700_000): WorldState {
  const model = buildModelFromTemplate({
    businessName: 'First Location',
    template: getSeedTemplate('full_service_restaurant'),
    scale: {
      seats: 64,
      turnsPerDay: 2,
      addressableTrafficPerQuarter: 180_000,
      captureRate: 0.05,
      price: fromDisplay(42),
    },
    equityInjection: fromDisplay(equity),
    debt: [{ kind: 'SBA_7A', principal: fromDisplay(400_000), termQuarters: 40 }],
  });
  return createWorld({
    id: 'portfolio',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
}

const cloneAction = (state: WorldState, equity: number, scale = 1): Action => ({
  kind: 'START_BUSINESS',
  mode: 'CLONE',
  cloneFromId: state.businesses[0]!.id,
  clone: { name: 'Second Location', equity: fromDisplay(equity), scale },
});

/** Run far enough for the two-quarter lead time to have elapsed. */
function open(state: WorldState, equity = 900_000, scale = 1): WorldState {
  let current = state;
  for (let i = 0; i < 4; i++) {
    current = tick(current, i === 0 ? [cloneAction(current, equity, scale)] : [], {
      throwOnAssertionFailure: true,
    }).state;
  }
  return current;
}

describe('cloning a business', () => {
  it('copies the structure and leaves the history behind', () => {
    const after = open(world());
    expect(after.businesses).toHaveLength(2);
    const clone = after.businesses[1]!;
    const parent = after.businesses[0]!;

    // The concept came over.
    expect(clone.streams[0]!.params.kind).toBe(parent.streams[0]!.params.kind);
    expect(clone.costs.stepFixed.map((c) => c.label)).toEqual(
      parent.costs.stepFixed.map((c) => c.label),
    );
    expect(clone.clonedFrom).toBe(parent.id);

    // The balance sheet did not. A clone that inherited its parent's debts and
    // retained earnings would be a second copy of the same money.
    expect(clone.debts).toHaveLength(0);
    expect(clone.balances.retainedEarnings).not.toBe(parent.balances.retainedEarnings);
    expect(clone.streams[0]!.state.quartersSinceLaunch).toBeLessThan(
      parent.streams[0]!.state.quartersSinceLaunch,
    );
    // Bought new: depreciation starts at the clone's own opening, so after the
    // same elapsed quarters it has accumulated far less than its parent's.
    for (const asset of clone.assets) expect(asset.acquiredPeriod).toBeGreaterThan(0);
    const wear = (b: typeof parent): bigint =>
      sum(b.assets.map((a) => a.accumulatedDepreciation));
    expect(wear(clone)).toBeLessThan(wear(parent));
  });

  it('gives it §9.5’s execution advantage without ever making it a penalty', () => {
    const before = world();
    const parentFloor = before.businesses[0]!.streams[0]!.modifiers.rampFloor;
    const after = open(before);
    const cloneFloor = after.businesses[1]!.streams[0]!.modifiers.rampFloor;

    expect(cloneFloor).toBeCloseTo(Math.min(CLONE_RAMP_CEILING, parentFloor + 0.1), 6);
    // The `min` is against a ceiling above the highest seeded floor, so an
    // already-experienced operator is never handed a worse ramp than they had.
    expect(cloneFloor).toBeGreaterThanOrEqual(parentFloor);
  });

  it('scales the site when asked for a bigger one', () => {
    const after = open(world(), 3_000_000, 3);
    const parent = after.businesses[0]!;
    const clone = after.businesses[1]!;
    const parentParams = parent.streams[0]!.params;
    const cloneParams = clone.streams[0]!.params;
    if (parentParams.kind !== 'TRAFFIC' || cloneParams.kind !== 'TRAFFIC') throw new Error('shape');

    expect(cloneParams.addressableTrafficPerQuarter).toBeCloseTo(
      parentParams.addressableTrafficPerQuarter * 3,
      6,
    );
    // The building scaled with it, and so did the rent.
    const rentOf = (b: typeof parent): Money =>
      sum(b.costs.fixedPeriod.map((c) => c.amountPerQuarter));
    expect(Number(rentOf(clone))).toBeGreaterThan(Number(rentOf(parent)) * 2.5);
  });

  it('takes the money from the household at commit, not at opening', () => {
    const before = world();
    const cash = before.household.cash;
    const committed = fromDisplay(900_000);

    const first = tick(before, [cloneAction(before, 900_000)], { throwOnAssertionFailure: true });
    // Paid immediately — §9.3.1: month-zero outlays at commit.
    expect(first.state.household.cash).toBeLessThanOrEqual(cash - committed);
    // And nothing exists yet.
    expect(first.state.businesses).toHaveLength(1);

    let current = first.state;
    for (let i = 0; i < 3; i++) current = tick(current, [], { throwOnAssertionFailure: true }).state;
    expect(current.businesses).toHaveLength(2);
  });

  it('refuses one the household cannot fund, and keeps the money', () => {
    const before = world();
    const result = tick(before, [cloneAction(before, 500_000_000)], {
      throwOnAssertionFailure: true,
    });
    expect(result.events.some((e) => e.kind === 'ACTION_REJECTED')).toBe(true);
    // Against a control rather than against the opening balance: the quarter
    // takes living expenses and personal tax whatever the player does, and
    // comparing to the start would credit the refusal with those too.
    const control = tick(world(), [], { throwOnAssertionFailure: true });
    expect(result.state.household.cash).toBe(control.state.household.cash);
    // And the refusal stops the delayed half too, or it opens anyway two
    // quarters later on money that was never paid.
    let current = result.state;
    for (let i = 0; i < 3; i++) current = tick(current, [], { throwOnAssertionFailure: true }).state;
    expect(current.businesses).toHaveLength(1);
  });

  it('refuses one funded for less than its own buildout', () => {
    const before = world();
    const needed = cloneOutlay(before.businesses[0]!, 1);
    expect(needed).toBeGreaterThan(0n);
    const result = tick(before, [cloneAction(before, Number(needed) / 100 / 2)], {
      throwOnAssertionFailure: true,
    });
    expect(result.events.some((e) => e.kind === 'ACTION_REJECTED')).toBe(true);
  });

  it('keeps the consolidated books tying across both', () => {
    let current = open(world());
    for (let i = 0; i < 12; i++) {
      const result = tick(current, [], { throwOnAssertionFailure: true });
      expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
      const bs = result.statements.consolidated.balanceSheet;
      expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
      current = result.state;
    }
    expect(current.businesses).toHaveLength(2);
  });

  it('will not clone a business that no longer exists', () => {
    const before = world();
    const result = tick(
      before,
      [
        {
          kind: 'START_BUSINESS',
          mode: 'CLONE',
          cloneFromId: 'nope',
          clone: { name: 'Ghost', equity: fromDisplay(900_000), scale: 1 },
        },
      ],
      { throwOnAssertionFailure: true },
    );
    expect(result.events.some((e) => e.kind === 'ACTION_REJECTED')).toBe(true);
    expect(result.state.businesses).toHaveLength(1);
  });

  it('still refuses a brand-new concept, and says where it happens', () => {
    const result = tick(world(), [{ kind: 'START_BUSINESS', mode: 'FULL_INTERVIEW' }], {
      throwOnAssertionFailure: true,
    });
    const rejection = result.events.find((e) => e.kind === 'ACTION_REJECTED');
    expect(String(rejection?.detail['reason'])).toMatch(/full interview/);
  });
});

describe('selling one', () => {
  it('pays the household and takes the business off the board', () => {
    let current = open(world());
    // Long enough for the clone to have four quarters of trailing EBITDA.
    for (let i = 0; i < 8; i++) current = tick(current, [], { throwOnAssertionFailure: true }).state;

    const target = current.businesses[1]!;
    const cash = current.household.cash;
    const expected = saleValue(target, 4);

    current = tick(current, [{ kind: 'SELL_BUSINESS', businessId: target.id }], {
      throwOnAssertionFailure: true,
    }).state;
    // Two quarters to close, per §9.3.1.
    expect(current.businesses[1]!.status).not.toBe('SOLD');
    for (let i = 0; i < 3; i++) current = tick(current, [], { throwOnAssertionFailure: true }).state;

    expect(current.businesses[1]!.status).toBe('SOLD');
    expect(current.household.cash).toBeGreaterThan(cash);
    expect(expected).toBeGreaterThan(0n);
    // The stake is gone with it.
    expect(current.household.stakes.some((s) => s.businessId === target.id)).toBe(false);
  });

  it('never pays out a negative number for a business worth less than its debts', () => {
    // A losing business with a mortgage on it. The buyer takes the debt, so the
    // equity cheque is nothing — which is what "the bank takes it" looks like,
    // not a bill sent to the seller.
    const state = world();
    const business = state.businesses[0]!;
    business.trailingEbitda = [fromDisplay(-100_000), fromDisplay(-100_000)];
    business.cash = fromDisplay(10_000);
    business.debts = [
      {
        ...business.debts[0]!,
        outstandingPrincipal: fromDisplay(2_000_000),
      },
    ];
    expect(saleValue(business, 4)).toBe(0n);
  });

  it('values it on trailing EBITDA at the multiple asked for', () => {
    const state = world();
    const business = state.businesses[0]!;
    business.trailingEbitda = [fromDisplay(50_000), fromDisplay(50_000), fromDisplay(50_000), fromDisplay(50_000)];
    const atFour = saleValue(business, 4);
    const atSix = saleValue(business, 6);
    expect(atSix).toBeGreaterThan(atFour);
    // Enterprise value less what it owes, plus the cash on hand.
    expect(atSix - atFour).toBe(fromDisplay(200_000) * 2n);
  });
});

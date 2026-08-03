import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { getSeedTemplate } from '@bizsim/seeds';
import type { Action, WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { tick } from './tick.js';

/**
 * What the engine refuses, and what a refusal means.
 *
 * A player asked how to pay off his SBA loan, was told how to borrow, and
 * reasoned his way to `debt -$400k`. It was accepted. Two quarters later his
 * balance sheet carried a second SBA facility with -$400,000 outstanding, and
 * every articulation assertion still passed — a balance sheet ties just as
 * happily around a liability with the wrong sign.
 *
 * The command layer refuses this now too, but the engine is what makes it
 * true. Anything that can construct an Action can reach the ledger: the CLI,
 * the setup flow, a replay of a log written before the guard existed.
 */

function world(equity = 700_000): WorldState {
  const model = buildModelFromTemplate({
    businessName: 'Guarded',
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
    id: 'guarded',
    playerId: 'p',
    config: createWorldConfig({ startMode: 'MID' }),
    models: [model],
  });
}

const rejections = (events: { kind: string }[]): number =>
  events.filter((e) => e.kind === 'ACTION_REJECTED').length;

describe('money that runs backwards', () => {
  it('refuses to raise a negative loan, and books nothing when it does', () => {
    const state = world();
    const business = state.businesses[0]!;
    const before = business.debts.length;

    const borrow: Action = {
      kind: 'RAISE_DEBT',
      businessId: business.id,
      spec: {
        kind: 'SBA_7A',
        requestedPrincipal: fromDisplay(-400_000),
        termQuarters: 40,
        personalGuarantee: true,
      },
    };

    let current = state;
    let seen = 0;
    // Through the lead time, because the bug was not the submission — it was
    // the delayed half arriving two quarters later and booking the facility.
    for (let i = 0; i < 4; i++) {
      const result = tick(current, i === 0 ? [borrow] : [], { throwOnAssertionFailure: true });
      seen += rejections(result.events);
      current = result.state;
    }

    expect(seen).toBeGreaterThan(0);
    expect(current.businesses[0]!.debts.length).toBe(before);
    for (const debt of current.businesses[0]!.debts) {
      expect(debt.outstandingPrincipal).toBeGreaterThanOrEqual(0n);
    }
  });

  it('refuses a negative repayment, which would be a drawdown wearing a disguise', () => {
    const state = world();
    const business = state.businesses[0]!;
    const debt = business.debts[0]!;
    const owed = debt.outstandingPrincipal;
    expect(owed).toBeGreaterThan(0n);

    const result = tick(
      state,
      [{ kind: 'REPAY_DEBT', debtId: debt.id, amount: fromDisplay(-50_000) }],
      { throwOnAssertionFailure: true },
    );
    expect(rejections(result.events)).toBeGreaterThan(0);
    expect(result.state.businesses[0]!.debts[0]!.outstandingPrincipal).toBeLessThanOrEqual(owed);
  });

  it('refuses a price of zero rather than dividing the demand curve by it', () => {
    const state = world();
    const result = tick(
      state,
      [{ kind: 'SET_PRICE', streamId: state.businesses[0]!.streams[0]!.id, newPrice: 0n }],
      { throwOnAssertionFailure: true },
    );
    expect(rejections(result.events)).toBeGreaterThan(0);
  });
});

describe('a refusal at submission is a refusal', () => {
  it('does not let a declined loan arrive anyway two quarters later', () => {
    // The lender declined at submission and the action was scheduled regardless.
    // The MATURED branch then re-underwrote it, ignored the answer, and pushed
    // the facility — so "the lender said no" meant "the lender said no, and the
    // money turned up on schedule".
    const state = world(120_000);
    const business = state.businesses[0]!;
    const before = business.debts.length;

    const absurd: Action = {
      kind: 'RAISE_DEBT',
      businessId: business.id,
      spec: {
        kind: 'SBA_7A',
        // Far past anything this business could service or collateralise.
        requestedPrincipal: fromDisplay(40_000_000),
        termQuarters: 40,
        personalGuarantee: true,
      },
    };

    let current = state;
    let declined = false;
    for (let i = 0; i < 4; i++) {
      const result = tick(current, i === 0 ? [absurd] : [], { throwOnAssertionFailure: false });
      if (result.events.some((e) => e.kind === 'UNDERWRITING_DECLINED')) declined = true;
      current = result.state;
    }

    expect(declined, 'the lender approved a $40M loan against a restaurant').toBe(true);
    expect(current.businesses[0]!.debts.length).toBe(before);
  });
});

describe('repaying principal early', () => {
  it('reduces the balance by what was paid and leaves the books tied', () => {
    const state = world();
    const debt = state.businesses[0]!.debts[0]!;
    const owed = debt.outstandingPrincipal;
    expect(owed).toBeGreaterThan(0n);
    const payment = owed / 4n;

    const result = tick(state, [{ kind: 'REPAY_DEBT', debtId: debt.id, amount: payment }], {
      throwOnAssertionFailure: true,
    });
    const after = result.state.businesses[0]!.debts.find((d) => d.id === debt.id)!;
    // Scheduled amortisation runs in the same quarter, so the balance falls by
    // at least the payment rather than exactly it.
    expect(after.outstandingPrincipal).toBeLessThanOrEqual(owed - payment);
    expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
  });

  it('pays off no more than is owed, however much is offered', () => {
    const state = world();
    const debt = state.businesses[0]!.debts[0]!;
    expect(debt.outstandingPrincipal).toBeGreaterThan(0n);

    const result = tick(
      state,
      [{ kind: 'REPAY_DEBT', debtId: debt.id, amount: debt.outstandingPrincipal * 10n }],
      { throwOnAssertionFailure: false },
    );
    const after = result.state.businesses[0]!.debts.find((d) => d.id === debt.id)!;
    expect(after.outstandingPrincipal).toBe(0n);
  });
});

import { describe, expect, it } from 'vitest';
import { fromDisplay, type Money } from '@bizsim/money';
import { getSeedTemplate, benchmarkSecurity, getSecurity, listSecurities } from '@bizsim/seeds';
import type { Action, WorldState } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { createWorld, createWorldConfig } from './opening.js';
import { priceAt, portfolioValue, totalReturnValue } from './market.js';
import { tick } from './tick.js';

/**
 * The market, and the promise it must not break.
 *
 * §1.3 forbids randomness in the engine and replay depends on it absolutely.
 * A market needs a price path, which is the first thing here that looks like
 * noise — so the first two tests are the ones that matter: the same seed gives
 * the same decade forever, and different seeds give different ones.
 */

function world(marketSeed?: number): WorldState {
  const model = buildModelFromTemplate({
    businessName: 'Investor',
    template: getSeedTemplate('full_service_restaurant'),
    scale: { seats: 64, turnsPerDay: 2, price: fromDisplay(42) },
    equityInjection: fromDisplay(400_000),
  });
  return createWorld({
    id: 'investor',
    playerId: 'p',
    config: createWorldConfig(
      marketSeed === undefined ? { startMode: 'MID' } : { startMode: 'MID', marketSeed },
    ),
    models: [model],
  });
}

const buy = (ticker: string, amount: number): Action => ({
  kind: 'BUY_SECURITY',
  ticker,
  amount: fromDisplay(amount),
});

describe('prices without randomness (§1.3)', () => {
  it('gives the same decade to the same seed, every time', () => {
    const index = benchmarkSecurity();
    for (const period of [1, 7, 23, 40]) {
      expect(priceAt(index, 12_345, period)).toBe(priceAt(index, 12_345, period));
    }
    // And a fresh walk from period 0 agrees with itself — there is no cached
    // state anywhere for a second call to diverge from.
    const twice = [priceAt(index, 999, 40), priceAt(index, 999, 40)];
    expect(twice[0]).toBe(twice[1]);
  });

  it('gives different decades to different seeds', () => {
    const index = benchmarkSecurity();
    const paths = [1, 2, 3, 4, 5].map((s) => priceAt(index, s * 104_729, 40));
    expect(new Set(paths.map(String)).size).toBe(paths.length);
  });

  it('moves the price, or it is a bond wearing a stock’s name', () => {
    const index = benchmarkSecurity();
    const path = [4, 8, 12, 16, 20].map((p) => priceAt(index, 4_242, p));
    expect(new Set(path.map(String)).size).toBeGreaterThan(1);
    // A zero-volatility instrument is the exception, and is exactly flat in
    // price: T-bills pay their return as a coupon, not as appreciation.
    const tbill = getSecurity('TBILL')!;
    expect(priceAt(tbill, 4_242, 20)).toBe(tbill.openingPrice);
  });

  it('does not smuggle extra return in through volatility', () => {
    // Without the half-variance correction in the log-return, raising an
    // instrument's volatility silently raises its expected price too — and a
    // player comparing the index against the tech name would be reading an
    // artefact of the parameterisation rather than a risk premium.
    for (const security of listSecurities()) {
      if (security.annualVolatility === 0) continue;
      let total = 0;
      const runs = 300;
      for (let s = 0; s < runs; s++) {
        total += Number(totalReturnValue(security, s * 7_919, fromDisplay(1_000_000), 0, 40));
      }
      const mean = total / runs / Number(fromDisplay(1_000_000));
      const assumed = (1 + security.expectedAnnualPriceReturn + security.dividendYield) ** 10;
      // Within 15% of the assumption over 300 paths — sampling error at these
      // volatilities is real, a systematic drift bug is not this small.
      expect(Math.abs(mean / assumed - 1), security.ticker).toBeLessThan(0.15);
    }
  });
});

describe('holding something', () => {
  it('moves household cash into a position and back out again', () => {
    let state = world();
    const opening = state.household.cash;

    state = tick(state, [buy('IDX', 500_000)], { throwOnAssertionFailure: true }).state;
    expect(state.household.holdings).toHaveLength(1);
    expect(state.household.holdings[0]!.costBasis).toBe(fromDisplay(500_000));
    expect(state.household.holdings[0]!.shares).toBeGreaterThan(0);
    // The cash left, less what the quarter's own living expenses took.
    expect(state.household.cash).toBeLessThan(opening - fromDisplay(499_000));

    const shares = state.household.holdings[0]!.shares;
    const before = state.household.cash;
    state = tick(state, [{ kind: 'SELL_SECURITY', ticker: 'IDX', shares }], {
      throwOnAssertionFailure: true,
    }).state;
    expect(state.household.holdings).toHaveLength(0);
    expect(state.household.cash).toBeGreaterThan(before);
  });

  it('counts the portfolio as net worth rather than as money destroyed', () => {
    const base = tick(world(), [], { throwOnAssertionFailure: true });
    const invested = tick(world(), [buy('IDX', 500_000)], { throwOnAssertionFailure: true });
    // Buying $500k of an index fund is not a $500k loss. Before the portfolio
    // was in net worth, that is exactly what it looked like.
    const gap =
      base.statements.household.netWorth - invested.statements.household.netWorth;
    expect(gap).toBeLessThan(fromDisplay(20_000));
    expect(gap).toBeGreaterThan(fromDisplay(-20_000));
    expect(invested.statements.household.securitiesValue).toBeGreaterThan(fromDisplay(400_000));
  });

  it('pays dividends and taxes them', () => {
    let state = world();
    state = tick(state, [buy('KO', 1_000_000)], { throwOnAssertionFailure: true }).state;
    const result = tick(state, [], { throwOnAssertionFailure: true });
    const hh = result.statements.household;
    // A 3.1% yield on roughly $1M is roughly $7.75k a quarter.
    expect(hh.dividendsReceived).toBeGreaterThan(fromDisplay(5_000));
    expect(hh.dividendsReceived).toBeLessThan(fromDisplay(12_000));
    // And the tax on it landed, at the personal rate.
    expect(hh.personalTaxPaid).toBeGreaterThan(0n);
  });

  it('will not spend household cash it does not have', () => {
    const state = world();
    const available = state.household.cash;
    const after = tick(state, [buy('IDX', 999_000_000)], { throwOnAssertionFailure: true }).state;
    expect(after.household.cash).toBeGreaterThanOrEqual(0n);
    expect(after.household.holdings[0]!.costBasis).toBeLessThanOrEqual(available);
  });

  it('refuses a negative purchase and a negative sale', () => {
    const state = world();
    const bad = tick(
      state,
      [
        { kind: 'BUY_SECURITY', ticker: 'IDX', amount: fromDisplay(-100_000) },
        { kind: 'SELL_SECURITY', ticker: 'IDX', shares: -5 },
      ],
      { throwOnAssertionFailure: true },
    );
    expect(bad.events.filter((e) => e.kind === 'ACTION_REJECTED').length).toBe(2);
    expect(bad.state.household.holdings).toHaveLength(0);
  });

  it('keeps the business books tied, because none of this is the business’s', () => {
    // The household buys; the company's statements must not notice.
    let state = world();
    for (let i = 0; i < 8; i++) {
      const result = tick(state, i === 0 ? [buy('IDX', 300_000)] : [], {
        throwOnAssertionFailure: true,
      });
      expect(result.assertions.filter((a) => !a.passed)).toEqual([]);
      state = result.state;
    }
    expect(portfolioValue(state, state.currentPeriod)).toBeGreaterThan(0n);
  });
});

describe('the benchmark', () => {
  it('reinvests dividends rather than dropping them', () => {
    const ko = getSecurity('KO')!;
    const invested: Money = fromDisplay(1_000_000);
    const withDividends = totalReturnValue(ko, 777, invested, 0, 40);
    const priceOnly =
      (priceAt(ko, 777, 40) * invested) / priceAt(ko, 777, 0);
    // A 3.1% yield compounded over ten years is worth roughly a third again.
    expect(withDividends).toBeGreaterThan(priceOnly);
  });

  it('is a real alternative, not a formality', () => {
    // The whole reason this exists: $2.4M left alone for ten years is a number
    // every run has to beat, and it is a large one.
    const index = benchmarkSecurity();
    const passive = totalReturnValue(index, 20_243_414, fromDisplay(2_400_000), 0, 40);
    expect(passive).toBeGreaterThan(fromDisplay(4_000_000));
  });
});

import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import type { WorldState } from '@bizsim/schemas';
import { SCENARIOS } from './scenarios.js';
import { benchmarkLines, portfolioLines, positions, quoteLines } from './portfolio.js';

/**
 * The market, as the player reads it.
 *
 * The arithmetic is tested against the engine; these are about the sentences,
 * because the sentence is the product here. "You beat it by $6.6M" is the
 * entire reason the feature exists.
 */

const world = (): WorldState => SCENARIOS['storage']!();

describe('quotes', () => {
  it('lists the catalog with its assumptions on show', () => {
    const lines = quoteLines(world(), 0).join('\n');
    expect(lines).toMatch(/IDX/);
    expect(lines).toMatch(/TBILL/);
    // The returns are catalog figures, and the screen says so rather than
    // letting them read as forecasts.
    expect(lines).toMatch(/not forecasts/);
  });
});

describe('the portfolio', () => {
  it('says nothing is held rather than printing an empty table', () => {
    expect(portfolioLines(world(), 0).join('\n')).toMatch(/Nothing invested/);
  });

  it('values a position at market and shows the gain against cost', () => {
    const state = world();
    state.household.holdings.push({ ticker: 'IDX', shares: 1_000, costBasis: fromDisplay(400_000) });
    const held = positions(state, 12);
    expect(held).toHaveLength(1);
    expect(held[0]!.value).toBeGreaterThan(0n);
    expect(held[0]!.gain).toBe(held[0]!.value - fromDisplay(400_000));
    expect(portfolioLines(state, 12).join('\n')).toMatch(/IDX/);
  });

  it('ignores a ticker that is no longer in the catalog instead of crashing', () => {
    const state = world();
    state.household.holdings.push({ ticker: 'GONE', shares: 10, costBasis: fromDisplay(1_000) });
    expect(positions(state, 4)).toHaveLength(0);
  });
});

describe('the benchmark', () => {
  it('states both numbers and which way the comparison went', () => {
    const state = world();
    const lines = benchmarkLines(state, fromDisplay(50_000_000), 40).join('\n');
    expect(lines).toMatch(/You started with/);
    expect(lines).toMatch(/untouched/);
    expect(lines).toMatch(/You beat it by/);
  });

  it('does not soften a loss', () => {
    const state = world();
    const lines = benchmarkLines(state, fromDisplay(100_000), 40).join('\n');
    expect(lines).toMatch(/It beat you by/);
  });

  it('names a wipeout as one', () => {
    const state = world();
    expect(benchmarkLines(state, fromDisplay(-500_000), 40).join('\n')).toMatch(/wiped out/);
  });

  it('separates idle cash from the business’s own performance', () => {
    // A player who takes the $5M tier and puts $400k into a restaurant leaves
    // $4.6M earning nothing for a decade, and the comparison books all of it
    // against the restaurant. Fair about their wealth, unfair about their
    // business — so the part that just sat there gets named.
    const state = world();
    state.household.cash = fromDisplay(4_000_000);
    const lines = benchmarkLines(state, fromDisplay(4_700_000), 40).join('\n');
    expect(lines).toMatch(/never left your current account/);

    state.household.cash = fromDisplay(10_000);
    expect(benchmarkLines(state, fromDisplay(4_700_000), 40).join('\n')).not.toMatch(
      /never left your current account/,
    );
  });
});

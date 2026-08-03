import { mulRate, toCompact, toDisplay, type Money } from '@bizsim/money';
import { priceAt, totalReturnValue } from '@bizsim/engine';
import { benchmarkSecurity, getSecurity, listSecurities } from '@bizsim/seeds';
import type { PeriodIndex, WorldState } from '@bizsim/schemas';

/**
 * The market, as the player sees it.
 *
 * The reason this exists is not stock picking. A business with $1.1M of idle
 * cash earning 0% is being compared against nothing, and "your hotel returned
 * 14% on equity" is a number without a scale until something says what the
 * money would have done elsewhere. Everything below serves that sentence; the
 * ability to actually buy Coca-Cola is a side effect of making the comparison
 * honest enough to act on.
 */

export function quoteLines(state: WorldState, period: PeriodIndex): string[] {
  const lines = ['  TICKER  PRICE      YIELD   ASSUMED RETURN   VOLATILITY'];
  for (const security of listSecurities()) {
    const price = priceAt(security, state.config.marketSeed, period);
    const move =
      security.openingPrice > 0n
        ? (Number(price) / Number(security.openingPrice) - 1) * 100
        : 0;
    lines.push(
      `  ${security.ticker.padEnd(8)}${toDisplay(price, { showCents: false }).padEnd(11)}` +
        `${(security.dividendYield * 100).toFixed(1).padStart(5)}%   ` +
        `${(security.expectedAnnualPriceReturn * 100).toFixed(1).padStart(6)}%/yr        ` +
        `${(security.annualVolatility * 100).toFixed(0).padStart(3)}%` +
        (period > 0 ? `   ${move >= 0 ? '+' : ''}${move.toFixed(1)}% since open` : ''),
    );
  }
  lines.push('  `buy IDX 500k` · `sell IDX all` · assumed returns are catalog figures, not forecasts');
  return lines;
}

export interface Position {
  ticker: string;
  label: string;
  shares: number;
  costBasis: Money;
  value: Money;
  /** Unrealised, before the tax a sale would trigger. */
  gain: Money;
}

export function positions(state: WorldState, period: PeriodIndex): Position[] {
  return state.household.holdings.flatMap((holding) => {
    const security = getSecurity(holding.ticker);
    if (!security) return [];
    const price = priceAt(security, state.config.marketSeed, period);
    const value = mulRate(price, holding.shares);
    return [
      {
        ticker: security.ticker,
        label: security.label,
        shares: holding.shares,
        costBasis: holding.costBasis,
        value,
        gain: value - holding.costBasis,
      },
    ];
  });
}

export function portfolioLines(state: WorldState, period: PeriodIndex): string[] {
  const held = positions(state, period);
  if (held.length === 0) {
    return ['  Nothing invested. `quotes` lists what the catalog holds.'];
  }
  const lines = held.map(
    (p) =>
      `  ${p.ticker.padEnd(8)}${p.shares.toFixed(0).padStart(9)} sh  ` +
      `${toCompact(p.value).padStart(9)}  cost ${toCompact(p.costBasis).padStart(9)}  ` +
      `${p.gain >= 0n ? '+' : ''}${toCompact(p.gain)}`,
  );
  const total = held.reduce<Money>((a, p) => a + p.value, 0n);
  lines.push(`  ${'TOTAL'.padEnd(8)}${' '.repeat(12)}${toCompact(total).padStart(9)}`);
  return lines;
}

/**
 * What the whole run was worth against leaving the money alone.
 *
 * The comparison is deliberately the simplest defensible one: everything the
 * player started with, left in the index for the same number of quarters, with
 * dividends reinvested. It ignores the timing of injections and draws, which
 * would make it more accurate and much harder to argue with — and the number
 * has to be arguable to be worth printing.
 */
export function benchmarkLines(state: WorldState, netWorth: Money, period: PeriodIndex): string[] {
  const index = benchmarkSecurity();
  const passive = totalReturnValue(index, state.config.marketSeed, state.config.startCapital, 0, period);
  const years = period / 4;
  const rate = (value: Money): string => {
    if (state.config.startCapital <= 0n || years <= 0) return 'n/a';
    const growth = Number(value) / Number(state.config.startCapital);
    if (growth <= 0) return 'wiped out';
    return `${((Math.pow(growth, 1 / years) - 1) * 100).toFixed(1)}%/yr`;
  };

  const delta = netWorth - passive;
  const lines = [
    `You started with ${toCompact(state.config.startCapital)} and ended with ${toCompact(netWorth)} — ${rate(netWorth)}.`,
    `The same money in ${index.label.toLowerCase()}, untouched: ${toCompact(passive)} — ${rate(passive)}.`,
    delta >= 0n
      ? `You beat it by ${toCompact(delta)}. That is what the work was worth.`
      : `It beat you by ${toCompact(-delta)}. Ten years of running something is the price of the difference.`,
  ];

  /**
   * How much of the gap was never a business decision at all.
   *
   * A player who takes the $5M tier and puts $400k into a restaurant leaves
   * $4.6M in a current account earning nothing for a decade, and the comparison
   * above books all of that against the restaurant. It is a fair statement
   * about their wealth and an unfair one about their business, so the part that
   * simply sat there gets named.
   */
  const idle = state.household.cash;
  if (netWorth > 0n && idle * 4n > netWorth) {
    lines.push(
      `${toCompact(idle)} of that never left your current account, where it earned nothing at all. ` +
        `Idle cash is a decision too — \`buy TBILL\` is the floor, \`buy IDX\` is the comparison above.`,
    );
  }
  return lines;
}

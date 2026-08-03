import { mulRate, sum, type Money } from '@bizsim/money';
import { getSecurity } from '@bizsim/seeds';
import type { PeriodIndex, Security, WorldState } from '@bizsim/schemas';

/**
 * Prices, without randomness.
 *
 * §1.3 forbids `Math.random()` and `Date.now()` in the engine, and replay
 * depends on that absolutely: the same actions against the same world have to
 * produce the same books, forever. A stock that does not move is a bond, so a
 * market needs a path — and this is the first thing in the engine that looks
 * like noise.
 *
 * It is not noise. Every price is a pure function of (seed, ticker, period)
 * through a hash, so the path is fixed the moment the world is created, nothing
 * about it is stored, nothing can drift, and replaying a run reproduces every
 * quote exactly. Two worlds with different seeds get different decades; the
 * same seed gets the same decade every time it is run.
 *
 * The path is a geometric walk: log-return per quarter is the drift less the
 * half-variance correction, plus a shock scaled by quarterly volatility. That
 * correction matters — without it, raising a security's volatility silently
 * raises its expected price too, and a player comparing the index against a
 * tech name would be reading an artefact of the parameterisation.
 */

/** FNV-1a. Small, fast, and stable across engines — which is the requirement. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32, seeded per (ticker, period). One draw each; no carried state. */
function uniform(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * A standard normal from twelve uniforms (Irwin–Hall).
 *
 * Box–Muller would be more exact and needs `log` and `cos` of a value that can
 * be zero. Twelve draws summed minus six has unit variance by construction, no
 * edge cases, and tails that stop at ±6 sigma — which for a ten-year quarterly
 * path is a feature rather than a limitation.
 */
function normal(seed: number): number {
  let total = 0;
  for (let i = 0; i < 12; i++) total += uniform(seed + i * 0x9e3779b9);
  return total - 6;
}

/** The log-return of one quarter. Deterministic in (seed, ticker, period). */
function quarterlyLogReturn(security: Security, marketSeed: number, period: PeriodIndex): number {
  const sigma = security.annualVolatility / 2; // √4 quarters
  const drift = Math.log(1 + security.expectedAnnualPriceReturn) / 4 - (sigma * sigma) / 2;
  if (sigma === 0) return drift;
  return drift + sigma * normal(hash(`${marketSeed}:${security.ticker}:${period}`));
}

/**
 * The price of one share at the close of `period`.
 *
 * Walked from period 0 rather than cached. A forty-quarter run costs forty
 * multiplications per quote, which is nothing, and it buys the property that
 * matters: there is no price anywhere in WorldState, so no price can be stale,
 * mutated by a bug, or diverge between a live run and its replay.
 */
export function priceAt(security: Security, marketSeed: number, period: PeriodIndex): Money {
  let cumulative = 0;
  for (let p = 1; p <= period; p++) cumulative += quarterlyLogReturn(security, marketSeed, p);
  // One float→Money conversion at the end, per the money rules: floats reach
  // money only through mulRate.
  return mulRate(security.openingPrice, Math.exp(cumulative));
}

/** One quarter of dividend on a position. Yields are quoted annually. */
export const quarterlyDividend = (security: Security, price: Money, shares: number): Money =>
  mulRate(price, (shares * security.dividendYield) / 4);

/**
 * What a lump sum left alone in this security would be worth by `period`.
 *
 * The benchmark the run is scored against: price appreciation plus dividends
 * reinvested at the price of the quarter they were paid. A business that
 * returned 14% on equity over ten years while the index returned 9% earned its
 * founder five points; one that returned 6% cost them three, and until this
 * existed the game had no way to say either sentence.
 */
export function totalReturnValue(
  security: Security,
  marketSeed: number,
  invested: Money,
  fromPeriod: PeriodIndex,
  toPeriod: PeriodIndex,
): Money {
  const entry = priceAt(security, marketSeed, fromPeriod);
  if (entry <= 0n) return invested;
  let shares = Number(invested) / Number(entry);
  for (let p = fromPeriod + 1; p <= toPeriod; p++) {
    const price = priceAt(security, marketSeed, p);
    if (price <= 0n) continue;
    const dividend = quarterlyDividend(security, price, shares);
    shares += Number(dividend) / Number(price);
  }
  return mulRate(priceAt(security, marketSeed, toPeriod), shares);
}

/** What every position is worth at the close of `period`, at market. */
export function portfolioValue(state: WorldState, period: PeriodIndex): Money {
  return sum(
    state.household.holdings.map((holding) => {
      const security = getSecurity(holding.ticker);
      if (!security) return 0n;
      return mulRate(priceAt(security, state.config.marketSeed, period), holding.shares);
    }),
  );
}

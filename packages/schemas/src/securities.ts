import { z } from 'zod';
import { zMoney, zNonNegative, type Money } from './primitives.js';

/**
 * Passive investments — the alternative use of the player's capital.
 *
 * A player with $5M asked to buy Coca-Cola stock and was told, after eleven
 * seconds of thought and a follow-up question, that the simulator does not do
 * that. The refusal was correct about the product and wrong about the need: a
 * business with $1.1M of idle cash earning 0% is being compared against
 * nothing, and "your hotel returned 14% on equity" means very little without
 * "and the index did 9%".
 *
 * So this exists for the opportunity cost first and the stock picking second.
 * It is deliberately small: a catalog of instruments, a deterministic price
 * path, dividends, and the tax on both. There is no order book, no bid-ask, no
 * intraday anything, and no live data — the engine has no network and never
 * will (§1.3).
 *
 * Prices are CATALOG provenance (§10.3): the opening price and the assumed
 * return are seeded data a player can argue with, not a quote. A model asked
 * for a live price should say it cannot get one, because it cannot.
 */

export const zSecurity = z.object({
  ticker: z.string(),
  label: z.string(),
  /** What one share cost at period 0. Every later price derives from this. */
  openingPrice: zMoney,
  /** Annual dividend as a share of price, paid in four equal quarterly parts. */
  dividendYield: zNonNegative,
  /** Expected annual PRICE return, before volatility and before dividends. */
  expectedAnnualPriceReturn: z.number(),
  /** Annualised standard deviation of the price path. Zero is a bond. */
  annualVolatility: zNonNegative,
  /**
   * The broad-market instrument the run is scored against. Exactly one in the
   * catalog carries this, and it is what "the index did 9%" refers to.
   */
  isBenchmark: z.boolean().default(false),
  sourceNote: z.string(),
});
export type Security = z.infer<typeof zSecurity>;

/**
 * A position, and what was paid for it.
 *
 * Cost basis is carried in aggregate rather than per lot. Lot accounting would
 * change the tax on a partial sale and nothing else, and the simplification is
 * stated on screen rather than hidden: an average-cost basis is what most
 * founders would report anyway.
 */
export interface Holding {
  ticker: string;
  shares: number;
  costBasis: Money;
}

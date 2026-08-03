import { fromDisplay, mulRate, type Money } from '@bizsim/money';
import { priceEffect, streamVariableCosts } from '@bizsim/engine';
import type { Business, RevenueStream, StreamMetrics } from '@bizsim/schemas';

/**
 * Price, in the units the player is thinking in.
 *
 * A hotel owner running a 64-key property was told `price 8213` sets his rate.
 * That figure is correct — the OCCUPANCY archetype stores revenue per occupied
 * key per quarter — and it is meaningless to someone who has spent the whole
 * session thinking in a nightly rate of about $90. The command still takes the
 * engine's number, because that is what the engine stores; what was missing was
 * the sentence translating it.
 *
 * The same problem is milder elsewhere and still real: a subscription's ARPU is
 * quarterly and every SaaS price on earth is quoted monthly.
 */

/** 365.25 / 4. Quarters are not 90 days and a nightly rate off by 1.5% is worse than none. */
const NIGHTS_PER_QUARTER = 91.3125;

/** Lodging rents by the night; everything else in this archetype rents by the month. */
const LODGING = /\b(hotel|motel|inn|resort|lodge|hostel|bnb|b&b|room|rooms|key|keys|night|nightly|suite|cabin|campsite|site)\b/i;

export interface PriceUnits {
  /** What `price <n>` takes: whole dollars of the stored per-unit price. */
  command: number;
  /** The engine's unit, named. */
  per: string;
  /** The same money in the unit a human quotes, when there is a different one. */
  colloquial?: string;
}

/** Cents to whole units, as a number. `toDisplay` returns a formatted string. */
const dollarsOf = (m: Money): number => Number(m) / 100;

export function priceUnits(stream: RevenueStream, price: Money): PriceUnits {
  const command = Math.round(dollarsOf(price));
  // Cents on a $90 monthly rent are noise; cents on a $4.50 one are the number.
  const dollars = (v: number): string =>
    v >= 10 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(2)}`;

  switch (stream.params.kind) {
    case 'OCCUPANCY': {
      const nightly = LODGING.test(stream.label);
      const per = nightly
        ? `${dollars(dollarsOf(price) / NIGHTS_PER_QUARTER)} a night`
        : `${dollars(dollarsOf(price) / 3)} a month`;
      return { command, per: 'per unit per quarter', colloquial: per };
    }
    case 'SUBSCRIPTION':
      return {
        command,
        per: 'per subscriber per quarter',
        colloquial: `${dollars(dollarsOf(price) / 3)} a month`,
      };
    case 'UTILIZATION':
      return { command, per: 'per billable hour' };
    case 'TRAFFIC':
      return { command, per: 'per visit' };
    case 'UNITS_CAC':
      return { command, per: 'per order' };
    case 'PROJECT_BACKLOG':
      return { command, per: 'per contract' };
  }
}

// ---------------------------------------------------------------------------
// The optimum
// ---------------------------------------------------------------------------

/**
 * "What's the optimal price?"
 *
 * Asked directly, and answered with the same paragraph about elasticity the
 * player had already been shown twice. It is a computable question: the engine
 * prices demand as a constant-elasticity response to a reference price, so
 * contribution as a function of price is a curve this code can walk.
 *
 * Walked rather than solved. The closed form for the interior optimum is
 * `x* = (c/r)·ε/(ε−1)`, but it is wrong wherever capacity binds, wrong when the
 * elasticity ratio hits the engine's [0.4, 3.0] guardrail, and undefined for
 * ε ≤ 1. A grid over the defensible band evaluates the same objective the
 * engine would and is right in every regime, at a cost of a few hundred
 * multiplications once per question.
 *
 * The objective is contribution, not revenue. Fixed and step costs do not move
 * with price within a quarter, so maximising contribution maximises EBITDA —
 * with one honest omission noted to the player: a lower volume can sometimes
 * shed a staffing block, which this does not credit.
 */
export interface PriceOptimum {
  /** The price to set, in cents. */
  price: Money;
  /** price / current price. 1.0 means the current price is already the best one. */
  factor: number;
  /** Contribution per quarter at the optimum, and at today's price. */
  contribution: Money;
  contributionNow: Money;
  /** Volume at the optimum, against today's. */
  volume: number;
  volumeNow: number;
  /** What stops it going further in the direction it wants to go. */
  binding: 'CAPACITY' | 'CONTRIBUTION' | 'MODEL_BAND';
  elasticity: number;
  /**
   * True when the whole defensible band is worth within 2% of the same
   * contribution.
   *
   * At an elasticity of exactly 1 the volume response gives back precisely what
   * the rate change takes, and the curve is a plateau; near 1 it is close
   * enough that the argmax is noise. Handing someone "cut your rent 22% to earn
   * the same money" as a recommendation is worse than saying nothing, and the
   * true finding — price is not a lever in this business — is more useful than
   * either.
   */
  flat: boolean;
  /** The edges of the band the model will defend, for saying so out loud. */
  band: { low: Money; high: Money };
}

export function priceOptimum(
  business: Business,
  stream: RevenueStream,
  metrics: StreamMetrics,
  currentPrice: Money,
): PriceOptimum | undefined {
  const reference = stream.params.referencePrice;
  const elasticity = stream.modifiers.priceElasticity;
  if (currentPrice <= 0n || reference <= 0n || metrics.realizedVolume <= 0) return undefined;

  const variable = streamVariableCosts(business, stream);
  const capacity = metrics.capacityVolume ?? Number.POSITIVE_INFINITY;

  // Revenue per unit of driver at today's price, which is NOT the price itself:
  // an occupancy stream adds ancillary revenue and gives concessions back, and
  // both are proportions, so both scale with the price lever.
  const revenuePerUnit = Number(metrics.revenue) / metrics.realizedVolume;

  // Demand at the reference price, backed out of what actually happened. Using
  // the engine's own priceEffect keeps this exact even when today's price is
  // already outside the band and the response is frozen.
  const now = priceEffect(currentPrice, reference, elasticity);
  if (now.multiplier <= 0) return undefined;
  const demandAtReference = metrics.demandVolume / now.multiplier;

  const contributionAt = (price: Money): { value: number; volume: number } => {
    const demand = demandAtReference * priceEffect(price, reference, elasticity).multiplier;
    const volume = Math.min(demand, capacity);
    const perUnit =
      (revenuePerUnit * (Number(price) / Number(currentPrice))) * (1 - variable.pctOfRevenue) -
      Number(variable.perUnit);
    return { value: volume * perUnit, volume };
  };

  // The band is the engine's, not a taste judgement: outside [0.4, 3.0] of the
  // reference price the demand response is clamped, and a recommendation that
  // lives there is an answer about the clamp rather than about the business.
  const low = mulRate(reference, 0.4);
  const high = mulRate(reference, 3.0);
  const steps = 200;

  let bestPrice = currentPrice;
  let bestValue = contributionAt(currentPrice).value;
  let worstValue = bestValue;
  for (let i = 0; i <= steps; i++) {
    const price = low + ((high - low) * BigInt(i)) / BigInt(steps);
    if (price <= 0n) continue;
    const candidate = contributionAt(price);
    if (candidate.value > bestValue) {
      bestValue = candidate.value;
      bestPrice = price;
    }
    worstValue = Math.min(worstValue, candidate.value);
  }

  // Rounded before the figures are computed, not after: quoting a contribution
  // for $11,847 and a command for $11,850 is two answers to one question.
  const price = clamp(tidyPrice(bestPrice), low, high);
  const best = contributionAt(price);
  const here = contributionAt(currentPrice);
  const atEdge = price > currentPrice ? price >= high - 1n : price <= low + 1n;
  const clears = Number.isFinite(capacity) && best.volume >= capacity - 1e-9;

  return {
    price,
    factor: Number(price) / Number(currentPrice),
    contribution: BigInt(Math.round(best.value)),
    contributionNow: BigInt(Math.round(here.value)),
    volume: best.volume,
    volumeNow: here.volume,
    binding: atEdge ? 'MODEL_BAND' : clears ? 'CAPACITY' : 'CONTRIBUTION',
    elasticity,
    flat: bestValue - worstValue <= Math.abs(bestValue) * 0.02,
    band: { low, high },
  };
}

const clamp = (v: Money, low: Money, high: Money): Money => (v < low ? low : v > high ? high : v);

/** A price rounded to something a human would actually put on a rate card. */
export function tidyPrice(price: Money): Money {
  const dollars = dollarsOf(price);
  if (dollars >= 1000) return fromDisplay(Math.round(dollars / 50) * 50);
  if (dollars >= 100) return fromDisplay(Math.round(dollars / 5) * 5);
  return fromDisplay(Math.round(dollars));
}

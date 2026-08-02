import { ratio, type Money } from '@bizsim/money';
import type { SharedModifierParams } from '@bizsim/schemas';

/**
 * Shared modifiers — spec §3.0. Implemented once, reused by all six archetypes.
 */

/**
 * A new location does not hit steady state immediately.
 * Reaches ~97% of steady state by quarter 9 at the default rampConstant of 3.
 */
export function maturityRamp(q: number, rampFloor: number, rampConstant: number): number {
  if (q <= 0) return rampFloor;
  return rampFloor + (1 - rampFloor) * (1 - Math.exp(-q / rampConstant));
}

/**
 * Diminishing returns on marketing spend. Deterministic, and visible to the
 * player as an editable assumption — §10.4 requires that any figure this drives
 * is annotated with the driving assumption and its provenance tag, because the
 * MVP has no stochastic noise to remind the player these are inputs.
 */
export function marketingMultiplier(
  spend: Money,
  maxLift: number,
  halfSaturationSpend: Money,
): number {
  if (halfSaturationSpend <= 0n) return 1 + maxLift;
  if (spend <= 0n) return 1;
  return 1 + maxLift * (1 - Math.exp(-ratio(spend, halfSaturationSpend)));
}

export interface PriceEffect {
  multiplier: number;
  clamped: boolean;
  rawRatio: number;
}

/**
 * Constant-elasticity response relative to the price set at concept lock.
 *
 * The RATIO is clamped, not the result. Extrapolating constant elasticity
 * beyond ±3× is not defensible, and clamping the output instead would leave the
 * curve's shape distorted inside the defensible region.
 */
export function priceEffect(
  price: Money,
  referencePrice: Money,
  elasticity: number,
): PriceEffect {
  if (referencePrice <= 0n) return { multiplier: 1, clamped: false, rawRatio: 1 };
  const raw = ratio(price, referencePrice);
  const clampedRatio = Math.min(3.0, Math.max(0.4, raw));
  return {
    multiplier: Math.pow(clampedRatio, -elasticity),
    clamped: clampedRatio !== raw,
    rawRatio: raw,
  };
}

/**
 * Spec §3.0: `spendRatio = marketingSpend / baseMarketingSpend`. Consumed only
 * by CAC inflation, but the base it divides by now lives on the shared
 * modifiers so it is defined for every archetype (docs/plan/03-spec-gaps.md G-1).
 */
export function spendRatio(spend: Money, modifiers: SharedModifierParams): number {
  if (modifiers.baseMarketingSpendPerQuarter <= 0n) return spend > 0n ? Number.POSITIVE_INFINITY : 1;
  return ratio(spend, modifiers.baseMarketingSpendPerQuarter);
}

/**
 * Spending more to acquire more gets progressively more expensive. Without
 * this, the optimal strategy is always "spend infinite marketing" and the model
 * becomes a money printer (§3.3).
 */
export function effectiveCac(
  baseCac: Money,
  cacInflationCoefficient: number,
  ratioOfSpend: number,
): Money {
  const inflation = 1 + cacInflationCoefficient * Math.max(0, ratioOfSpend - 1);
  return baseCac <= 0n ? 0n : BigInt(Math.round(Number(baseCac) * inflation));
}

/** Calendar quarter. Seasonality is ALWAYS indexed by this, never by `q` (§3.0). */
export const quarterOfYear = (currentPeriod: number): number =>
  ((currentPeriod % 4) + 4) % 4;

export function seasonalityFactor(
  seasonality: readonly [number, number, number, number],
  currentPeriod: number,
): number {
  return seasonality[quarterOfYear(currentPeriod)] ?? 1;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * Spec §3.1. The hook for the 256-flavour case: more SKUs raises per-customer
 * service time, which lowers throughput, which caps revenue at peak. Derived by
 * the engine, never by the LLM, and exposed as an editable assumption.
 */
export function serviceComplexityFactor(skuCount: number, baselineSkuCount: number): number {
  const denom = baselineSkuCount > 0 ? baselineSkuCount : 1;
  return 1.0 + 0.1 * Math.log2(Math.max(1, skuCount / denom));
}

import { mulRate, sum, type Money } from '@bizsim/money';
import type { Business, FixedAsset, PeriodIndex } from '@bizsim/schemas';

/**
 * Straight-line depreciation — spec §2.5.
 *
 * Begins the quarter AFTER acquisition, and accumulated depreciation never
 * exceeds `grossCost - salvageValue`. Both details are load-bearing: the first
 * because §9.3.1 gives PURCHASE_ASSET its cost this quarter and its effect next
 * quarter, the second because §8.4 asserts it.
 */

export interface DepreciationResult {
  total: Money;
  byAsset: Map<string, Money>;
}

export function quarterlyDepreciation(asset: FixedAsset, period: PeriodIndex): Money {
  if (period <= asset.acquiredPeriod) return 0n;
  const depreciableBase = asset.grossCost - asset.salvageValue;
  if (depreciableBase <= 0n) return 0n;
  const remaining = depreciableBase - asset.accumulatedDepreciation;
  if (remaining <= 0n) return 0n;

  const perQuarter = mulRate(depreciableBase, 1 / (asset.usefulLifeYears * 4));
  return perQuarter > remaining ? remaining : perQuarter;
}

export function computeDepreciation(business: Business, period: PeriodIndex): DepreciationResult {
  const byAsset = new Map<string, Money>();
  for (const asset of business.assets) {
    byAsset.set(asset.id, quarterlyDepreciation(asset, period));
  }
  return { total: sum([...byAsset.values()]), byAsset };
}

export const ppeGross = (business: Business): Money =>
  sum(business.assets.map((a) => a.grossCost));

export const accumulatedDepreciation = (business: Business): Money =>
  sum(business.assets.map((a) => a.accumulatedDepreciation));

export const netBookValue = (asset: FixedAsset): Money =>
  asset.grossCost - asset.accumulatedDepreciation;

export const totalSalvageValue = (business: Business): Money =>
  sum(business.assets.map((a) => a.salvageValue));

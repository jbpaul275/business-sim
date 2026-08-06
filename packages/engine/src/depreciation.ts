import { mulRate, sum, type Money } from '@bizsim/money';
import type { Business, FixedAsset, PeriodIndex } from '@bizsim/schemas';
import { LINE, type TickContext } from './context.js';
import { factor as asFactor, money as asMoney, number as asNumber } from './derivation.js';

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

export function computeDepreciation(
  business: Business,
  period: PeriodIndex,
  ctx?: TickContext,
): DepreciationResult {
  const byAsset = new Map<string, Money>();
  for (const asset of business.assets) {
    const charge = quarterlyDepreciation(asset, period);
    byAsset.set(asset.id, charge);
    if (ctx?.tracing && charge > 0n) {
      ctx.derive(`asset.${asset.id}.depreciation`, {
        label: asset.label,
        line: LINE.depreciation,
        steps: [
          { label: 'Cost of the asset', value: asMoney(asset.grossCost) },
          ...(asset.salvageValue !== 0n
            ? [{ label: 'Salvage value', value: asMoney(asset.salvageValue), op: '−' as const }]
            : []),
          {
            label: 'Useful life',
            value: asNumber(asset.usefulLifeYears * 4, 'quarters'),
            op: '÷',
            note: `${asset.usefulLifeYears} years, straight line`,
          },
          ...(charge < mulRate(asset.grossCost - asset.salvageValue, 1 / (asset.usefulLifeYears * 4))
            ? [
                {
                  label: 'Capped',
                  value: asFactor(1),
                  note: 'the asset is nearly written down — only the remaining basis is charged',
                },
              ]
            : []),
        ],
        result: asMoney(charge),
      });
    }
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

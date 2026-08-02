import type { Business, BusinessBalances, Money } from '@bizsim/schemas';
import type { CapacityResolution, CostBucket } from './costs.js';
import type { DemandResult, RealizeResult } from './archetypes.js';
import type { WorkingCapitalBalances } from './workingCapital.js';
import type { DebtServiceResult } from './debt.js';
import type { TaxResult } from './tax.js';

/**
 * The tick is split at the crisis re-entry point (§9.2 step 18 → step 8).
 *
 * `PreCrisis` is everything computed by steps 1–7: demand, capacity, revenue
 * and the two variable cost classes. It is computed once.
 *
 * `PostCrisis` is steps 8–17 — the part every crisis remedy invalidates. A
 * revolver draw changes interest, which changes pre-tax income, which changes
 * tax, which changes net income. Recomputing only the cash flow statement would
 * leave the income statement and balance sheet stale and the articulation
 * assertions would then fail, which is the GOOD outcome; the bad outcome is
 * silently disabling the assertion. So this half is a pure function of
 * (PreCrisis, business-as-mutated-by-remedies) and is recomputed from scratch
 * on each pass.
 */

export interface PreCrisis {
  business: Business;
  beginningCash: Money;
  beginningBalances: BusinessBalances;
  demands: DemandResult[];
  capacity: CapacityResolution;
  outcomes: RealizeResult[];
  revenueByStream: Map<string, Money>;
  revenue: Money;
  variableRevenueCosts: CostBucket;
  variableActivityCosts: CostBucket;
  marketingCosts: CostBucket;
  contributionMarginByStream: Map<string, number>;
}

/** Cash movements arising from player actions, before any crisis resolution. */
export interface ActionFlows {
  capex: Money;
  disposalProceeds: Money;
  disposalsAtCost: Money;
  accumDepOnDisposals: Money;
  gainOnDisposal: Money;
  debtDrawdowns: Money;
  debtOriginationFees: Money;
  principalRepayments: Money;
  ownerContributions: Money;
  ownerDistributions: Money;
  severance: Money;
  section179Deductions: Money;
  bookDepreciationOnElectedAssets: Money;
}

export const emptyActionFlows = (): ActionFlows => ({
  capex: 0n,
  disposalProceeds: 0n,
  disposalsAtCost: 0n,
  accumDepOnDisposals: 0n,
  gainOnDisposal: 0n,
  debtDrawdowns: 0n,
  debtOriginationFees: 0n,
  principalRepayments: 0n,
  ownerContributions: 0n,
  ownerDistributions: 0n,
  severance: 0n,
  section179Deductions: 0n,
  bookDepreciationOnElectedAssets: 0n,
});

/** State accumulated by crisis remedies across re-entry passes (§9.4). */
export interface CrisisFlows {
  factoredReceivables: Money;
  factoringCost: Money;
  deferOwnerComp: boolean;
  deferredOwnerCompDelta: Money;
  drawdowns: Money;
  originationFees: Money;
  householdInjection: Money;
  disposalProceeds: Money;
  disposalsAtCost: Money;
  accumDepOnDisposals: Money;
  gainOnDisposal: Money;
  appliedRemedies: string[];
  insolvent: boolean;
}

export const emptyCrisisFlows = (): CrisisFlows => ({
  factoredReceivables: 0n,
  factoringCost: 0n,
  deferOwnerComp: false,
  deferredOwnerCompDelta: 0n,
  drawdowns: 0n,
  originationFees: 0n,
  householdInjection: 0n,
  disposalProceeds: 0n,
  disposalsAtCost: 0n,
  accumDepOnDisposals: 0n,
  gainOnDisposal: 0n,
  appliedRemedies: [],
  insolvent: false,
});

export interface PostCrisis {
  stepFixedCosts: CostBucket;
  fixedPeriodCosts: CostBucket;
  ownerCompDeferred: Money;
  depreciation: Money;
  depreciationByAsset: Map<string, Money>;
  debtService: DebtServiceResult;
  tax: TaxResult;
  workingCapital: WorkingCapitalBalances;
  deltaNwc: Money;

  revenue: Money;
  cogs: Money;
  labor: Money;
  occupancy: Money;
  marketing: Money;
  generalAndAdmin: Money;
  ebitda: Money;
  ebit: Money;
  pretaxIncome: Money;
  netIncome: Money;
  accruableCosts: Money;

  cfo: Money;
  cfi: Money;
  cff: Money;
  endingCash: Money;
}

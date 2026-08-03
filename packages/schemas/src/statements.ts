import type { Money, PeriodIndex } from './primitives.js';

/**
 * Income statement — spec §8.1, with two additions below EBIT.
 *
 * `gainOnAssetDisposal` and `financingCosts` are not in the spec's §8.1. They
 * have to exist: `DISPOSE_ASSET` sells at a price that will not equal net book
 * value, and crisis remedies 3 and 6 (factoring, sale-leaseback) both produce a
 * P&L item with nowhere to land. Without them the retained-earnings assertion
 * in §8.4 fails the first time a player sells a truck. Both sit below EBITDA,
 * so no benchmark band, DSCR figure or break-even calculation moves.
 * See docs/plan/03-spec-gaps.md G-7.
 */
export interface IncomeStatement {
  revenue: Money;
  costOfGoodsSold: Money;
  grossProfit: Money;

  labor: Money;
  occupancy: Money;
  marketing: Money;
  generalAndAdmin: Money;
  ebitda: Money;

  depreciationAndAmortization: Money;
  ebit: Money;

  interestExpense: Money;
  gainOnAssetDisposal: Money;
  financingCosts: Money;
  pretaxIncome: Money;

  /**
   * C_CORP only. Pass-through entities owe no entity-level tax; they make a tax
   * distribution to the household instead, which is a financing outflow and a
   * reduction of retained earnings — not an expense (§7.1, §8.1). Booking both
   * would double-count and break the retained-earnings assertion.
   */
  incomeTaxExpense: Money;
  netIncome: Money;
}

/** Spec §8.2. */
export interface BalanceSheet {
  cash: Money;
  accountsReceivable: Money;
  retainageReceivable: Money;
  inventory: Money;
  prepaidExpenses: Money;
  currentAssets: Money;

  ppeGross: Money;
  accumulatedDepreciation: Money;
  ppeNet: Money;
  totalAssets: Money;

  accountsPayable: Money;
  accruedLiabilities: Money;
  deferredRevenue: Money;
  deferredOwnerComp: Money;
  currentPortionOfDebt: Money;
  currentLiabilities: Money;

  longTermDebt: Money;
  deferredTaxLiability: Money;
  totalLiabilities: Money;

  contributedCapital: Money;
  retainedEarnings: Money;
  totalEquity: Money;
}

/** Spec §8.3, indirect method. */
export interface CashFlowStatement {
  netIncome: Money;
  depreciationAndAmortization: Money;
  /** Non-cash movement in deferred tax, added back. C_CORP only. */
  deferredTaxes: Money;
  gainOnAssetDisposal: Money;
  changeInNetWorkingCapital: Money;
  cashFlowFromOperations: Money;

  capitalExpenditures: Money;
  proceedsFromDisposals: Money;
  cashFlowFromInvesting: Money;

  debtDrawdowns: Money;
  debtPrincipalRepayments: Money;
  debtOriginationFees: Money;
  ownerContributions: Money;
  ownerDistributions: Money;
  cashFlowFromFinancing: Money;

  netChangeInCash: Money;
  beginningCash: Money;
  endingCash: Money;
}

export interface HouseholdStatement {
  beginningCash: Money;
  livingExpenses: Money;
  distributionsReceived: Money;
  taxDistributionsReceived: Money;
  personalTaxPaid: Money;
  selfEmploymentTaxPaid: Money;
  injectionsMade: Money;
  personalDebtService: Money;
  endingCash: Money;
  netWorth: Money;
}

/** Spec §8.5. Computed, never LLM-generated. */
export interface DerivedMetrics {
  grossMarginPct: number;
  ebitdaMarginPct: number;
  netMarginPct: number;

  peakCashNeed: Money;
  peakCashNeedPeriod: PeriodIndex;
  cashRunwayQuarters: number;

  breakEvenRevenue: Money;
  breakEvenVolume?: { unit: string; value: number } | undefined;

  dscr: number;
  currentRatio: number;
  debtToEbitda: number;
  roic: number;
  cashConversionCycle: number;

  ownerEconomicReturn: Money;
  irrOnInvestedCapital?: number;

  /** Per-stream diagnostics the archetypes make available (§3.1–3.6). */
  streamMetrics: StreamMetrics[];
}

export interface StreamMetrics {
  streamId: string;
  label: string;
  archetype: string;
  demandVolume: number;
  realizedVolume: number;
  lostDemand: number;
  /**
   * The binding ceiling on volume this period — the lower of physical capacity
   * and staffed capacity — or undefined when nothing caps the stream.
   *
   * Without this, "demand 31,197 · served 31,197" is the only thing the player
   * ever sees, and it says nothing: served equals demand by construction until
   * the day it does not. The useful number is the headroom, which is the
   * difference between a business that is about to hit a wall and one that has
   * years of room.
   */
  capacityVolume?: number;
  revenue: Money;
  contributionMarginPct: number;
  /** UTILIZATION */
  realizedUtilization?: number;
  benchStress?: number;
  /** UNITS_CAC */
  effectiveCac?: Money;
  cacPaybackQuarters?: number;
  /** SUBSCRIPTION */
  ltvToCac?: number;
  /** OCCUPANCY */
  occupancy?: number;
  /** PROJECT_BACKLOG */
  backlogCoverageQuarters?: number;
}

export interface StatementSet {
  period: PeriodIndex;
  byBusiness: Record<
    string,
    {
      incomeStatement: IncomeStatement;
      balanceSheet: BalanceSheet;
      cashFlow: CashFlowStatement;
      derivedMetrics: DerivedMetrics;
    }
  >;
  consolidated: {
    incomeStatement: IncomeStatement;
    balanceSheet: BalanceSheet;
    cashFlow: CashFlowStatement;
  };
  household: HouseholdStatement;
  derivedMetrics: DerivedMetrics;
}

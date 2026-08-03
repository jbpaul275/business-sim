import { ratio, sum, type Money } from '@bizsim/money';
import type {
  BalanceSheet,
  Business,
  CashFlowStatement,
  DerivedMetrics,
  IncomeStatement,
  StreamMetrics,
  WorldConfig,
} from '@bizsim/schemas';
import { totalDebt } from './debt.js';
import { cashConversionCycle } from './workingCapital.js';
import type { CostBucket } from './costs.js';

/**
 * Derived metrics — spec §8.5. Computed, never LLM-generated.
 */

export interface MetricsInput {
  business: Business;
  config: WorldConfig;
  incomeStatement: IncomeStatement;
  balanceSheet: BalanceSheet;
  cashFlow: CashFlowStatement;
  stepFixedCosts: CostBucket;
  fixedPeriodCosts: CostBucket;
  streamMetrics: StreamMetrics[];
  debtServiceThisPeriod: Money;
}

export function computeDerivedMetrics(input: MetricsInput): DerivedMetrics {
  const { incomeStatement: is, balanceSheet: bs, cashFlow: cf, business } = input;

  const grossMarginPct = ratio(is.grossProfit, is.revenue);
  const fixedAndStep = input.stepFixedCosts.total + input.fixedPeriodCosts.total;

  // Break-even revenue = fixed and step costs ÷ gross margin. Uses BUSINESS
  // gross margin, which is a different number from the per-stream contribution
  // margin used for CAC payback and LTV/CAC (§3.0.3).
  const breakEvenRevenue =
    grossMarginPct > 0 ? BigInt(Math.round(Number(fixedAndStep) / grossMarginPct)) : 0n;

  const trailingEbitda = sum(business.trailingEbitda.slice(-4));
  const trailingDebtService = sum(business.trailingDebtService.slice(-4));

  const burn = cf.cashFlowFromOperations < 0n ? -cf.cashFlowFromOperations : 0n;
  const cashRunwayQuarters =
    burn > 0n ? ratio(bs.cash, burn) : Number.POSITIVE_INFINITY;

  const taxRate =
    business.legalForm === 'C_CORP'
      ? input.config.corporateTaxRate + input.config.stateCorporateTaxRate
      : input.config.personalTaxRate;
  const nopat = Number(is.ebit) * (1 - taxRate);
  const netWorkingCapital =
    bs.currentAssets - bs.cash - (bs.currentLiabilities - bs.currentPortionOfDebt);
  const investedCapital = Number(bs.ppeNet + netWorkingCapital);

  return {
    grossMarginPct,
    ebitdaMarginPct: ratio(is.ebitda, is.revenue),
    netMarginPct: ratio(is.netIncome, is.revenue),

    peakCashNeed: business.peakCashNeed,
    peakCashNeedPeriod: business.peakCashNeedPeriod,
    cashRunwayQuarters,

    breakEvenRevenue,
    ...(breakEvenVolume(business, input.streamMetrics, breakEvenRevenue) ?? {}),

    dscr: trailingDebtService > 0n ? ratio(trailingEbitda, trailingDebtService) : Number.POSITIVE_INFINITY,
    currentRatio: bs.currentLiabilities > 0n ? ratio(bs.currentAssets, bs.currentLiabilities) : Number.POSITIVE_INFINITY,
    debtToEbitda: trailingEbitda > 0n ? ratio(totalDebt(business), trailingEbitda) : Number.POSITIVE_INFINITY,
    roic: investedCapital > 0 ? nopat / investedCapital : 0,
    cashConversionCycle: cashConversionCycle(business),

    ownerEconomicReturn: bs.totalEquity,
    streamMetrics: input.streamMetrics,
  };
}

/**
 * The archetype-appropriate break-even figure. These are the operating numbers
 * an actual operator watches: covers per day, occupancy, utilisation.
 */
function breakEvenVolume(
  business: Business,
  streamMetrics: readonly StreamMetrics[],
  breakEvenRevenue: Money,
): { breakEvenVolume: DerivedMetrics['breakEvenVolume'] } | undefined {
  const primary = business.streams[0];
  const metrics = streamMetrics[0];
  if (!primary || !metrics || metrics.revenue <= 0n) return undefined;

  const revenueRatio = ratio(breakEvenRevenue, metrics.revenue);

  switch (primary.params.kind) {
    case 'TRAFFIC': {
      const days = primary.params.operatingDaysPerQuarter;
      return {
        breakEvenVolume: {
          // Not "covers". A ready-mix plant's post-mortem told its owner he
          // needed "12 covers/day" of concrete, because the first template
          // anyone wrote was a restaurant and its word became everyone's.
          unit: `${primary.volumeNoun}/day`,
          value: days > 0 ? (metrics.realizedVolume * revenueRatio) / days : 0,
        },
      };
    }
    case 'OCCUPANCY':
      return {
        breakEvenVolume: {
          unit: 'occupancy',
          value: (metrics.occupancy ?? 0) * revenueRatio,
        },
      };
    case 'UTILIZATION':
      return {
        breakEvenVolume: {
          unit: 'utilization',
          value: (metrics.realizedUtilization ?? 0) * revenueRatio,
        },
      };
    case 'PROJECT_BACKLOG':
      return { breakEvenVolume: { unit: 'win rate', value: primary.params.winRate * revenueRatio } };
    case 'SUBSCRIPTION':
      return {
        breakEvenVolume: { unit: primary.volumeNoun, value: metrics.realizedVolume * revenueRatio },
      };
    case 'UNITS_CAC':
      return {
        breakEvenVolume: {
          unit: `${primary.volumeNoun}/quarter`,
          value: metrics.realizedVolume * revenueRatio,
        },
      };
  }
}

/**
 * IRR on invested capital across the run (§8.5). Bisection on the NPV, which is
 * monotone for the conventional sign pattern these cash flows have (outflows
 * first, then inflows).
 */
export function irr(cashFlows: readonly Money[], tolerance = 1e-7): number | undefined {
  if (cashFlows.length < 2) return undefined;
  const npv = (rate: number): number =>
    cashFlows.reduce((acc, cf, i) => acc + Number(cf) / Math.pow(1 + rate, i), 0);

  let low = -0.9999;
  let high = 10;
  let npvLow = npv(low);
  let npvHigh = npv(high);
  if (npvLow * npvHigh > 0) return undefined;

  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const value = npv(mid);
    if (Math.abs(value) < tolerance) return mid;
    if (npvLow * value < 0) {
      high = mid;
      npvHigh = value;
    } else {
      low = mid;
      npvLow = value;
    }
  }
  return (low + high) / 2;
}

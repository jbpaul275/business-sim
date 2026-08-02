import { mulRate, type Money } from '@bizsim/money';
import type { Business, PeriodIndex, TaxState, WorldConfig } from '@bizsim/schemas';

/**
 * Tax — spec §7. Simple, but structurally honest.
 *
 * The engine ticks quarterly and every threshold in the tax code is annual: the
 * SE tax wage base, the §179 cap, the 80% NOL limitation. Applying an annual
 * band per quarter overstates the 15.3% SE bracket by up to 4×.
 *
 * So each quarter provides (tax on year-to-date income) − (tax already provided
 * year-to-date). That is both more correct and closer to how real quarterly
 * estimated payments work. Accumulators reset at the start of each tax year.
 * See docs/plan/03-spec-gaps.md G-6.
 */

/** Seed values. Real thresholds, versioned with the seed data. */
export const SE_TAX_WAGE_BASE: Money = 16_860_000n; // $168,600
export const SE_TAX_RATE_BELOW_BASE = 0.153;
export const SE_TAX_RATE_ABOVE_BASE = 0.029;
export const SE_TAX_BASE_FRACTION = 0.9235;
export const SECTION_179_CAP: Money = 122_000_000n; // $1,220,000
export const SECTION_179_PHASEOUT_THRESHOLD: Money = 305_000_000n; // $3,050,000
export const NOL_LIMITATION = 0.8;

export const isFirstQuarterOfTaxYear = (period: PeriodIndex): boolean => period % 4 === 0;
export const isLastQuarterOfTaxYear = (period: PeriodIndex): boolean => period % 4 === 3;

export const isPassThrough = (business: Business): boolean =>
  business.legalForm !== 'C_CORP';

export const owesSelfEmploymentTax = (business: Business): boolean =>
  business.legalForm === 'SOLE_PROP' || business.legalForm === 'LLC_PASSTHROUGH';

export interface TaxInput {
  pretaxIncome: Money;
  bookDepreciation: Money;
  /** §179 immediate expensing elected on assets acquired this period. */
  section179Deductions: Money;
  /** Book depreciation on §179-elected assets, which has no tax counterpart. */
  bookDepreciationOnElectedAssets: Money;
}

export interface TaxResult {
  /** C_CORP only. Pass-throughs owe no entity-level tax (§7.1, §8.1). */
  incomeTaxExpense: Money;
  /**
   * Pass-through only: a mandatory distribution to the household in the quarter
   * the tax is owed. Without it the model shows cash the founder does not have.
   * A financing outflow and a reduction of retained earnings — not an expense.
   */
  taxDistribution: Money;
  personalIncomeTax: Money;
  selfEmploymentTax: Money;
  deferredTaxLiabilityDelta: Money;
  taxState: TaxState;
  taxBasisIncome: Money;
  nolUsed: Money;
}

function seTaxOn(earnings: Money): Money {
  if (earnings <= 0n) return 0n;
  const base = mulRate(earnings, SE_TAX_BASE_FRACTION);
  const belowBase = base < SE_TAX_WAGE_BASE ? base : SE_TAX_WAGE_BASE;
  const aboveBase = base > SE_TAX_WAGE_BASE ? base - SE_TAX_WAGE_BASE : 0n;
  return mulRate(belowBase, SE_TAX_RATE_BELOW_BASE) + mulRate(aboveBase, SE_TAX_RATE_ABOVE_BASE);
}

/** §179 cap with the dollar-for-dollar phase-out above the purchase threshold. */
export function section179Allowance(
  totalPurchasesThisYear: Money,
  alreadyUsedThisYear: Money,
): Money {
  const excess =
    totalPurchasesThisYear > SECTION_179_PHASEOUT_THRESHOLD
      ? totalPurchasesThisYear - SECTION_179_PHASEOUT_THRESHOLD
      : 0n;
  const cap = SECTION_179_CAP - excess;
  const remaining = cap - alreadyUsedThisYear;
  return remaining > 0n ? remaining : 0n;
}

export function computeTax(
  business: Business,
  config: WorldConfig,
  period: PeriodIndex,
  input: TaxInput,
): TaxResult {
  const prior = business.taxState;

  // A fresh tax year resets the year-to-date accumulators but carries the NOL.
  const state: TaxState = isFirstQuarterOfTaxYear(period)
    ? {
        nolCarryforward: prior.nolCarryforward,
        section179UsedThisYear: 0n,
        ytdTaxableIncome: 0n,
        ytdTaxProvided: 0n,
        ytdSelfEmploymentEarnings: 0n,
        ytdSelfEmploymentTaxProvided: 0n,
      }
    : { ...prior };

  // Book/tax difference. Elected assets keep book depreciation on the income
  // statement and take the full deduction on the tax basis; the gap accumulates
  // in a single deferredTaxLiability line rather than a full schedule (§7.3).
  const taxDepreciation =
    input.bookDepreciation - input.bookDepreciationOnElectedAssets + input.section179Deductions;
  const quarterTaxBasisIncome =
    input.pretaxIncome + input.bookDepreciation - taxDepreciation;

  const ytdBasisBefore = state.ytdTaxableIncome;
  const ytdBasis = ytdBasisBefore + quarterTaxBasisIncome;
  state.ytdTaxableIncome = ytdBasis;
  state.section179UsedThisYear += input.section179Deductions;

  // NOL applied to year-to-date income, capped at 80% of it (§7.2).
  const positiveYtd = ytdBasis > 0n ? ytdBasis : 0n;
  const nolCap = mulRate(positiveYtd, NOL_LIMITATION);
  const nolUsed =
    state.nolCarryforward < nolCap ? state.nolCarryforward : nolCap;
  const ytdTaxable = positiveYtd - nolUsed;

  const rate = business.legalForm === 'C_CORP'
    ? config.corporateTaxRate + config.stateCorporateTaxRate
    : config.personalTaxRate;

  const taxOnYtd = mulRate(ytdTaxable, rate);
  const provision = taxOnYtd - state.ytdTaxProvided;
  state.ytdTaxProvided = taxOnYtd;

  // Self-employment tax, also on a year-to-date basis.
  let selfEmploymentTax = 0n;
  if (owesSelfEmploymentTax(business)) {
    state.ytdSelfEmploymentEarnings = ytdBasis;
    const seOnYtd = seTaxOn(ytdBasis);
    selfEmploymentTax = seOnYtd - state.ytdSelfEmploymentTaxProvided;
    state.ytdSelfEmploymentTaxProvided = seOnYtd;
  }

  // NOL is consumed and replenished at the close of the tax year, once the
  // year's result is final.
  if (isLastQuarterOfTaxYear(period)) {
    const loss = ytdBasis < 0n ? -ytdBasis : 0n;
    state.nolCarryforward = state.nolCarryforward - nolUsed + loss;
    if (state.nolCarryforward < 0n) state.nolCarryforward = 0n;
  }

  const isCorp = business.legalForm === 'C_CORP';

  // Only an entity-level taxpayer carries deferred tax. For a pass-through the
  // book/tax difference belongs to the owner's return, not the business's
  // balance sheet, so there is nothing to defer here.
  //
  // Where it does apply, the deferred movement is part of TAX EXPENSE, not a
  // free-standing liability. Recording the liability without the matching
  // expense would put a number on the balance sheet with no offsetting entry
  // and the sheet would stop balancing.
  const deferredTaxLiabilityDelta = isCorp
    ? mulRate(taxDepreciation - input.bookDepreciation, rate)
    : 0n;

  return {
    incomeTaxExpense: isCorp ? provision + deferredTaxLiabilityDelta : 0n,
    taxDistribution: isCorp ? 0n : provision + selfEmploymentTax,
    personalIncomeTax: isCorp ? 0n : provision,
    selfEmploymentTax,
    deferredTaxLiabilityDelta,
    taxState: state,
    taxBasisIncome: quarterTaxBasisIncome,
    nolUsed,
  };
}

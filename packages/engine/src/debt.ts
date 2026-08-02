import { mulRate, ratio, sum, type Money } from '@bizsim/money';
import type {
  Business,
  Covenant,
  Debt,
  DebtSpec,
  Household,
  PeriodIndex,
  WorldConfig,
} from '@bizsim/schemas';

/**
 * Financing — spec §6.
 */

/** Standard annuity payment per quarter (§6.1). */
export function annuityPayment(
  principal: Money,
  quarterlyRate: number,
  termQuarters: number,
): Money {
  if (termQuarters <= 0) return principal;
  if (quarterlyRate === 0) return mulRate(principal, 1 / termQuarters);
  const factor = quarterlyRate / (1 - Math.pow(1 + quarterlyRate, -termQuarters));
  return mulRate(principal, factor);
}

export interface DebtServiceLine {
  debtId: string;
  interest: Money;
  principal: Money;
  fees: Money;
}

export interface DebtServiceResult {
  interest: Money;
  principal: Money;
  fees: Money;
  byDebt: DebtServiceLine[];
}

/**
 * The interest/principal split, modelled correctly and shown to the player.
 * "My loan payment is an expense" is one of the most common and most damaging
 * errors in founder financial thinking; only the interest portion is an
 * expense, and the principal portion is a financing cash flow.
 */
export function computeDebtService(business: Business, period: PeriodIndex): DebtServiceResult {
  const byDebt: DebtServiceLine[] = [];

  for (const debt of business.debts) {
    if (debt.outstandingPrincipal <= 0n && debt.kind !== 'REVOLVER') continue;

    const r = debt.annualRate / 4;
    const interest = mulRate(debt.outstandingPrincipal, r);
    let principal = 0n;
    let fees = 0n;

    switch (debt.kind) {
      case 'REVOLVER': {
        // Interest on the drawn balance only, plus an unused-line fee.
        const limit = debt.revolverLimit ?? 0n;
        const undrawn = limit - debt.outstandingPrincipal;
        if (undrawn > 0n) fees = mulRate(undrawn, 0.0025 / 4);
        break;
      }
      case 'INTEREST_ONLY': {
        const maturity = debt.originatedPeriod + debt.termQuarters;
        if (period >= maturity) principal = debt.outstandingPrincipal; // balloon
        break;
      }
      default: {
        const payment = annuityPayment(debt.originalPrincipal, r, debt.termQuarters);
        principal = payment - interest;
        if (principal < 0n) principal = 0n;
        if (principal > debt.outstandingPrincipal) principal = debt.outstandingPrincipal;
      }
    }

    byDebt.push({ debtId: debt.id, interest, principal, fees });
  }

  return {
    interest: sum(byDebt.map((d) => d.interest)),
    principal: sum(byDebt.map((d) => d.principal)),
    fees: sum(byDebt.map((d) => d.fees)),
    byDebt,
  };
}

/** Principal falling due within four quarters — the current portion (§8.2). */
export function currentPortionOfDebt(business: Business, period: PeriodIndex): Money {
  let total = 0n;
  for (const debt of business.debts) {
    if (debt.outstandingPrincipal <= 0n) continue;
    if (debt.kind === 'REVOLVER') {
      total += debt.outstandingPrincipal;
      continue;
    }
    if (debt.kind === 'INTEREST_ONLY') {
      const maturity = debt.originatedPeriod + debt.termQuarters;
      if (maturity - period <= 4) total += debt.outstandingPrincipal;
      continue;
    }
    const r = debt.annualRate / 4;
    const payment = annuityPayment(debt.originalPrincipal, r, debt.termQuarters);
    let balance = debt.outstandingPrincipal;
    let due = 0n;
    for (let i = 0; i < 4 && balance > 0n; i++) {
      const interest = mulRate(balance, r);
      let principal = payment - interest;
      if (principal < 0n) principal = 0n;
      if (principal > balance) principal = balance;
      due += principal;
      balance -= principal;
    }
    total += due;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Underwriting — spec §6.3
// ---------------------------------------------------------------------------

export const DEBT_PRODUCTS: Record<
  Debt['kind'],
  { spreadOverPrime: number; originationFeePct: number; guaranteeRequired: boolean }
> = {
  SBA_7A: { spreadOverPrime: 0.03, originationFeePct: 0.03, guaranteeRequired: true },
  EQUIPMENT_FINANCE: { spreadOverPrime: 0.025, originationFeePct: 0.01, guaranteeRequired: false },
  REVOLVER: { spreadOverPrime: 0.02, originationFeePct: 0.005, guaranteeRequired: false },
  AMORTIZING: { spreadOverPrime: 0.015, originationFeePct: 0.01, guaranteeRequired: false },
  INTEREST_ONLY: { spreadOverPrime: 0.0, originationFeePct: 0.01, guaranteeRequired: false },
};

export interface UnderwritingDecision {
  approved: boolean;
  rate: number;
  requiresPersonalGuarantee: boolean;
  dscr: number | null;
  reason: string;
}

/**
 * DSCR = trailing 4q EBITDA / trailing 4q debt service, including the new
 * facility.
 *
 * Owner compensation and the maintenance reserve are NOT subtracted here. Both
 * already sit above EBITDA — owner comp in G&A, the maintenance reserve as a
 * FIXED_PERIOD line — so subtracting them again double-counts (§6.3).
 */
export function underwrite(
  business: Business,
  spec: DebtSpec,
  config: WorldConfig,
  household: Household,
  period: PeriodIndex,
): UnderwritingDecision {
  const product = DEBT_PRODUCTS[spec.kind];
  let rate = config.primeRate + product.spreadOverPrime;

  if (household.creditQuality === 'IMPAIRED') {
    rate += 0.03;
    if (
      spec.kind === 'SBA_7A' &&
      household.creditImpairedUntilPeriod !== undefined &&
      period < household.creditImpairedUntilPeriod
    ) {
      return {
        approved: false,
        rate,
        requiresPersonalGuarantee: true,
        dscr: null,
        reason: 'SBA 7(a) is unavailable while credit is impaired.',
      };
    }
  }

  const trailingEbitda = sum(business.trailingEbitda.slice(-4));
  const hasHistory = business.trailingEbitda.length >= 4;

  if (!hasHistory) {
    // Pre-revenue: underwrite on collateral coverage and owner equity injection.
    // This correctly makes the first loan hard and later loans easier.
    const collateral = sum(
      business.assets.map((a) =>
        mulRate(a.grossCost - a.accumulatedDepreciation, a.category === 'REAL_PROPERTY' ? 0.7 : 0.6),
      ),
    );
    const equityInjection = business.balances.contributedCapital;
    const minimumEquity = mulRate(spec.requestedPrincipal, 0.1); // SBA requires ≥10%

    if (spec.requestedPrincipal > collateral) {
      return {
        approved: false,
        rate,
        requiresPersonalGuarantee: true,
        dscr: null,
        reason:
          `Requested $${Number(spec.requestedPrincipal) / 100} exceeds collateral coverage of ` +
          `$${Number(collateral) / 100} and there is no trailing EBITDA to underwrite against.`,
      };
    }
    if (equityInjection < minimumEquity) {
      return {
        approved: false,
        rate,
        requiresPersonalGuarantee: true,
        dscr: null,
        reason: 'Owner equity injection is below the 10% minimum.',
      };
    }
    return {
      approved: true,
      rate,
      requiresPersonalGuarantee: true,
      dscr: null,
      reason: 'Approved on collateral coverage and owner equity injection.',
    };
  }

  const newRate = rate;
  const newService =
    spec.kind === 'REVOLVER'
      ? mulRate(spec.requestedPrincipal, newRate)
      : mulRate(annuityPayment(spec.requestedPrincipal, newRate / 4, spec.termQuarters), 4);
  const existingService = sum(business.trailingDebtService.slice(-4));
  const totalService = existingService + newService;
  const dscr = totalService > 0n ? ratio(trailingEbitda, totalService) : Number.POSITIVE_INFINITY;

  if (dscr >= 1.25) {
    return {
      approved: true,
      rate,
      requiresPersonalGuarantee: product.guaranteeRequired || spec.personalGuarantee,
      dscr,
      reason: `Approved: DSCR ${dscr.toFixed(2)} clears the 1.25 threshold.`,
    };
  }
  if (dscr >= 1.1) {
    return {
      approved: true,
      rate: rate + 0.015,
      requiresPersonalGuarantee: true,
      dscr,
      reason: `Approved with a 150bp step-up and a personal guarantee: DSCR ${dscr.toFixed(2)}.`,
    };
  }
  return {
    approved: false,
    rate,
    requiresPersonalGuarantee: true,
    dscr,
    reason:
      `Declined: DSCR ${dscr.toFixed(2)} is below 1.10. Trailing EBITDA would need to reach ` +
      `$${Math.round((Number(totalService) / 100) * 1.25).toLocaleString()} to clear underwriting.`,
  };
}

// ---------------------------------------------------------------------------
// Covenants — spec §6.4
// ---------------------------------------------------------------------------

export interface CovenantTest {
  debtId: string;
  covenant: Covenant;
  actual: number;
  breached: boolean;
}

export function testCovenants(
  business: Business,
  period: PeriodIndex,
  metrics: { dscr: number; currentRatio: number; debtToEbitda: number },
): CovenantTest[] {
  const results: CovenantTest[] = [];
  for (const debt of business.debts) {
    for (const covenant of debt.covenants) {
      const sinceOrigination = period - debt.originatedPeriod;
      if (sinceOrigination < 0) continue;
      if (sinceOrigination % covenant.testFrequencyQuarters !== 0) continue;

      const actual =
        covenant.metric === 'DSCR'
          ? metrics.dscr
          : covenant.metric === 'CURRENT_RATIO'
            ? metrics.currentRatio
            : metrics.debtToEbitda;

      const breached =
        covenant.operator === 'GTE' ? actual < covenant.threshold : actual > covenant.threshold;

      results.push({ debtId: debt.id, covenant, actual, breached });
    }
  }
  return results;
}

export const totalDebt = (business: Business): Money =>
  sum(business.debts.map((d) => d.outstandingPrincipal));
